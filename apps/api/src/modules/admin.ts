import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { PERMISSIONS, ROLES, STATE_CODES, can, isIsoDate, rolesFor, type Permission } from '@radcore/shared';
import { config } from '../config';
import { audit } from '../core/audit';
import {
  clearSessionCookie, hashPassword, login, logout, requireAuth, requirePerm, revokeUserSessions, setSessionCookie,
} from '../core/auth';
import { getSetting, loadPermissionOverrides, setSetting, type CompanyProfile } from '../core/settings';
import { rows, type DB } from '../db/client';
import {
  campaigns, expenseCategories, itemCategories, leadSources, locations, lostReasons, numberSeries, priceListItems,
  priceLists, users,
} from '../db/schema';
import { badRequest, forbidden, must } from '../lib/errors';
import { emptyToNull, inTx, sendList, zAddress, zGstin, zHttpUrl, zId, zMoney, zPhone, zStateCode, zText } from '../lib/http';

const zPassword = z.string().min(8, 'must be at least 8 characters').max(200);

/** What the screens need to know about this installation, sent along with who is signed in. */
const sessionExtras = async (db: DB) => ({
  sample_data: await getSetting(db, 'sample_data'),
  max_upload_mb: Math.floor(config.maxUploadBytes / 1024 / 1024),
});

export function authRouter(db: DB) {
  const r = Router();
  // Slow down password guessing.
  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false,
    skip: () => config.env === 'test' });

  r.post('/login', loginLimiter, async (req, res) => {
    const body = z.object({ identifier: z.string().min(1), password: z.string().min(1) }).parse(req.body);
    const { token, user } = await login(db, body.identifier, body.password);
    setSessionCookie(res, token);
    res.json({ user, permissions: permissionsFor(user.role), ...(await sessionExtras(db)) });
  });

  r.post('/logout', async (req, res) => {
    await logout(db, (req.cookies as Record<string, string>)[config.cookieName]);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  r.get('/me', requireAuth, async (req, res) => {
    res.json({ user: req.user, permissions: permissionsFor(req.user!.role), ...(await sessionExtras(db)) });
  });

  r.post('/change-password', requireAuth, async (req, res) => {
    const body = z.object({ current_password: z.string(), new_password: zPassword }).parse(req.body);
    const [u] = await db.select().from(users).where(eq(users.id, req.user!.id));
    if (!u || !(await bcrypt.compare(body.current_password, u.passwordHash))) throw badRequest('Current password is wrong');
    await db.update(users).set({ passwordHash: await hashPassword(body.new_password), updatedAt: new Date() }).where(eq(users.id, u.id));
    await revokeUserSessions(db, u.id);
    clearSessionCookie(res);
    res.json({ ok: true });
  });
  return r;
}

function permissionsFor(role: (typeof ROLES)[number]): string[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}

const publicUser = {
  id: users.id, name: users.name, phone: users.phone, email: users.email, role: users.role, active: users.active,
  createdAt: users.createdAt,
};

export function usersRouter(db: DB) {
  const r = Router();

  // Anyone signed in can see the staff list (needed for lead owners); only admin can change it.
  r.get('/', requireAuth, async (req, res) => {
    sendList(req, res, await db.select(publicUser).from(users).orderBy(asc(users.name)), 'users');
  });

  const zUser = z.object({
    name: zText(100),
    phone: zPhone,
    email: emptyToNull(z.string().email().toLowerCase()).optional(),
    role: z.enum(ROLES),
    password: zPassword,
  });

  r.post('/', requirePerm('users:manage'), async (req, res) => {
    const body = zUser.parse(req.body);
    const created = await inTx(db, req, async (ctx) => {
      const [u] = await ctx.tx
        .insert(users)
        .values({ name: body.name, phone: body.phone, email: body.email ?? null, role: body.role,
          passwordHash: await hashPassword(body.password), createdBy: ctx.user!.id })
        .returning(publicUser);
      await audit(ctx, 'user', u!.id, 'create', null, u);
      return u;
    });
    res.status(201).json({ data: created });
  });

  r.patch('/:id', requirePerm('users:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const body = zUser.omit({ password: true }).extend({ active: z.boolean(), password: zPassword }).partial().parse(req.body);
    const updated = await inTx(db, req, async (ctx) => {
      const [before] = await ctx.tx.select(publicUser).from(users).where(eq(users.id, id));
      must(before, 'User');
      if (id === ctx.user!.id && (body.active === false || (body.role && body.role !== 'admin'))) {
        throw badRequest('You cannot deactivate or demote yourself');
      }
      const { password, ...rest } = body;
      const [u] = await ctx.tx
        .update(users)
        .set({ ...rest, ...(password ? { passwordHash: await hashPassword(password) } : {}), updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning(publicUser);
      await audit(ctx, 'user', id, password ? 'update+password_reset' : 'update', before, u);
      return u;
    });
    // A deactivated user, or one whose password/role changed, is signed out everywhere.
    if (body.active === false || body.password || body.role) await revokeUserSessions(db, id);
    res.json({ data: updated });
  });
  return r;
}

export function settingsRouter(db: DB) {
  const r = Router();

  r.get('/', requireAuth, async (_req, res) => {
    res.json({
      data: {
        company: await getSetting(db, 'company'),
        period_lock_date: await getSetting(db, 'period_lock_date'),
        allow_negative_stock: await getSetting(db, 'allow_negative_stock'),
        valuation_method: await getSetting(db, 'valuation_method'),
        default_follow_up_days: await getSetting(db, 'default_follow_up_days'),
      },
      state_codes: STATE_CODES,
    });
  });

  const zCompany = z.object({
    name: zText(200),
    legal_name: z.string().max(200).optional(),
    gstin: emptyToNull(zGstin),
    state_code: zStateCode.refine((c) => Boolean(STATE_CODES[c]), 'unknown state code'),
    address: zAddress,
    phone: z.string().max(20).optional(),
    email: z.string().max(200).optional(),
    logo_url: emptyToNull(zHttpUrl).optional(),
    bank: z.object({
      account_name: z.string().max(200).optional(), account_no: z.string().max(40).optional(),
      ifsc: z.string().max(20).optional(), bank_name: z.string().max(200).optional(), upi_id: z.string().max(100).optional(),
    }).optional(),
    invoice_terms: z.string().max(2000).optional(),
  });

  /** The permission matrix as it stands: who holds what, and what the built-in default is. */
  r.get('/permissions', requirePerm('settings:manage'), async (_req, res) => {
    res.json({
      roles: ROLES,
      data: (Object.keys(PERMISSIONS) as Permission[]).map((key) => {
        const defaults = [...PERMISSIONS[key]] as string[];
        const roles = [...rolesFor(key)] as string[];
        return { key, roles, default_roles: defaults, changed: [...roles].sort().join() !== [...defaults].sort().join() };
      }),
    });
  });

  /**
   * Change which roles hold one permission. Only an admin, whatever else has been granted; the
   * admin role itself always holds everything, so nobody can lock the system shut from here.
   */
  r.put('/permissions/:key', requireAuth, async (req, res) => {
    if (req.user!.role !== 'admin') throw forbidden('Only an admin can change permissions');
    const key = String(req.params.key);
    if (!(key in PERMISSIONS)) throw must(null, 'Permission');
    const b = z.object({ roles: z.array(z.enum(ROLES)).max(ROLES.length) }).parse(req.body);
    const roles = [...new Set(b.roles)].filter((r) => r !== 'admin');
    const defaults = (PERMISSIONS[key as Permission] as readonly string[]).filter((r) => r !== 'admin');
    await inTx(db, req, async (ctx) => {
      const saved = { ...(await getSetting(ctx.tx, 'permission_overrides')) };
      const before = saved[key] ?? [...PERMISSIONS[key as Permission]];
      // Back to the built-in set: drop the override, so later changes to the defaults apply again.
      if ([...roles].sort().join() === [...defaults].sort().join()) delete saved[key];
      else saved[key] = roles;
      await setSetting(ctx.tx, 'permission_overrides', saved, ctx.user!.id);
      await audit(ctx, 'permission', key, 'update', { roles: before }, { roles });
    });
    await loadPermissionOverrides(db);
    res.json({ data: { key, roles: [...rolesFor(key as Permission)] } });
  });

  r.put('/company', requirePerm('settings:manage'), async (req, res) => {
    const body = zCompany.parse(req.body);
    // The state code is read from the GSTIN when there is one (PRD 7.9).
    if (body.gstin && body.gstin.slice(0, 2) !== body.state_code) {
      throw badRequest(`State code ${body.state_code} does not match the GSTIN (${body.gstin.slice(0, 2)})`);
    }
    await inTx(db, req, async (ctx) => {
      const before = await getSetting(ctx.tx, 'company');
      await setSetting(ctx.tx, 'company', body as CompanyProfile, ctx.user!.id);
      await audit(ctx, 'settings', 'company', 'update', before, body);
    });
    res.json({ data: body });
  });

  // Period lock belongs to Accounts (month close), not just admin.
  r.put('/period-lock', requirePerm('accounts:write'), async (req, res) => {
    const body = z.object({ period_lock_date: z.string().refine(isIsoDate, 'must be YYYY-MM-DD').nullable() }).parse(req.body);
    await inTx(db, req, async (ctx) => {
      const before = await getSetting(ctx.tx, 'period_lock_date');
      await setSetting(ctx.tx, 'period_lock_date', body.period_lock_date, ctx.user!.id);
      await audit(ctx, 'settings', 'period_lock_date', 'update', { value: before }, { value: body.period_lock_date });
    });
    res.json({ data: body });
  });

  r.put('/stock', requirePerm('settings:manage'), async (req, res) => {
    const body = z.object({ allow_negative_stock: z.boolean() }).parse(req.body);
    await inTx(db, req, async (ctx) => {
      const before = await getSetting(ctx.tx, 'allow_negative_stock');
      await setSetting(ctx.tx, 'allow_negative_stock', body.allow_negative_stock, ctx.user!.id);
      await audit(ctx, 'settings', 'allow_negative_stock', 'update', { value: before }, { value: body.allow_negative_stock });
    });
    res.json({ data: body });
  });

  r.get('/number-series', requirePerm('settings:manage'), async (req, res) => {
    sendList(req, res, await db.select().from(numberSeries).orderBy(asc(numberSeries.docType), asc(numberSeries.fy)));
  });

  r.get('/audit-log', requirePerm('audit:read'), async (req, res) => {
    const q = z.object({ entity: z.string().optional(), entity_id: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(req.query);
    const data = await rows(db, sql`
      select a.id, a.entity, a.entity_id, a.action, a.before, a.after, a.at, u.name as user_name
        from audit_log a left join users u on u.id = a.user_id
       where (${q.entity ?? null}::text is null or a.entity = ${q.entity ?? null})
         and (${q.entity_id ?? null}::text is null or a.entity_id = ${q.entity_id ?? null})
       order by a.id desc limit ${q.limit}`);
    sendList(req, res, data, 'audit-log');
  });
  return r;
}

/** Admin-managed lists (PRD 7.13): lead sources, lost reasons, categories, locations, price lists... */
export function mastersRouter(db: DB) {
  const r = Router();
  const zNameActive = z.object({ name: zText(100), active: z.boolean().optional() });

  // ---- lead sources ----
  r.get('/lead-sources', requireAuth, async (req, res) => {
    sendList(req, res, await db.select().from(leadSources).orderBy(asc(leadSources.name)));
  });
  r.post('/lead-sources', requirePerm('masters:manage'), async (req, res) => {
    const body = zNameActive.extend({ default_owner_id: emptyToNull(zId).optional() }).parse(req.body);
    const [row] = await db.insert(leadSources)
      .values({ name: body.name, active: body.active ?? true, defaultOwnerId: body.default_owner_id ?? null, createdBy: req.user!.id })
      .returning();
    res.status(201).json({ data: row });
  });
  r.patch('/lead-sources/:id', requirePerm('masters:manage'), async (req, res) => {
    const body = zNameActive.extend({ default_owner_id: emptyToNull(zId) }).partial().parse(req.body);
    const [row] = await db.update(leadSources)
      .set({ name: body.name, active: body.active, defaultOwnerId: body.default_owner_id, updatedAt: new Date() })
      .where(eq(leadSources.id, zId.parse(req.params.id))).returning();
    res.json({ data: must(row, 'Lead source') });
  });

  // ---- lost reasons ----
  r.get('/lost-reasons', requireAuth, async (req, res) => {
    sendList(req, res, await db.select().from(lostReasons).orderBy(asc(lostReasons.name)));
  });
  r.post('/lost-reasons', requirePerm('masters:manage'), async (req, res) => {
    const body = zNameActive.parse(req.body);
    const [row] = await db.insert(lostReasons).values({ ...body, createdBy: req.user!.id }).returning();
    res.status(201).json({ data: row });
  });
  r.patch('/lost-reasons/:id', requirePerm('masters:manage'), async (req, res) => {
    const body = zNameActive.partial().parse(req.body);
    const [row] = await db.update(lostReasons).set({ ...body, updatedAt: new Date() })
      .where(eq(lostReasons.id, zId.parse(req.params.id))).returning();
    res.json({ data: must(row, 'Lost reason') });
  });

  // ---- campaigns (public enquiry links / QR codes) ----
  r.get('/campaigns', requireAuth, async (req, res) => {
    sendList(req, res, await rows(db, sql`
      select c.*, s.name as source_name from campaigns c join lead_sources s on s.id = c.source_id order by c.created_at desc`));
  });
  r.post('/campaigns', requirePerm('masters:manage', 'leads:write'), async (req, res) => {
    const body = z.object({ name: zText(150), source_id: zId }).parse(req.body);
    const [row] = await db.insert(campaigns)
      .values({ name: body.name, sourceId: body.source_id, token: crypto.randomBytes(12).toString('base64url'), createdBy: req.user!.id })
      .returning();
    res.status(201).json({ data: row });
  });
  r.patch('/campaigns/:id', requirePerm('masters:manage', 'leads:write'), async (req, res) => {
    const body = z.object({ name: zText(150), active: z.boolean() }).partial().parse(req.body);
    const [row] = await db.update(campaigns).set({ ...body, updatedAt: new Date() })
      .where(eq(campaigns.id, zId.parse(req.params.id))).returning();
    res.json({ data: must(row, 'Campaign') });
  });

  // ---- item categories ----
  r.get('/item-categories', requireAuth, async (req, res) => {
    sendList(req, res, await db.select().from(itemCategories).orderBy(asc(itemCategories.name)));
  });
  r.post('/item-categories', requirePerm('masters:manage', 'items:write'), async (req, res) => {
    const body = zNameActive.extend({ parent_id: emptyToNull(zId).optional() }).parse(req.body);
    const [row] = await db.insert(itemCategories)
      .values({ name: body.name, active: body.active ?? true, parentId: body.parent_id ?? null, createdBy: req.user!.id }).returning();
    res.status(201).json({ data: row });
  });
  r.patch('/item-categories/:id', requirePerm('masters:manage', 'items:write'), async (req, res) => {
    const body = zNameActive.partial().parse(req.body);
    const [row] = await db.update(itemCategories).set({ ...body, updatedAt: new Date() })
      .where(eq(itemCategories.id, zId.parse(req.params.id))).returning();
    res.json({ data: must(row, 'Category') });
  });

  // ---- locations ----
  r.get('/locations', requireAuth, async (req, res) => {
    sendList(req, res, await db.select().from(locations).orderBy(asc(locations.createdAt)));
  });
  r.post('/locations', requirePerm('masters:manage'), async (req, res) => {
    const body = zNameActive.extend({ type: z.enum(['stores', 'showroom', 'rejected']) }).parse(req.body);
    const [row] = await db.insert(locations).values({ ...body, createdBy: req.user!.id }).returning();
    res.status(201).json({ data: row });
  });
  r.patch('/locations/:id', requirePerm('masters:manage'), async (req, res) => {
    const body = zNameActive.partial().parse(req.body);
    const [row] = await db.update(locations).set({ ...body, updatedAt: new Date() })
      .where(eq(locations.id, zId.parse(req.params.id))).returning();
    res.json({ data: must(row, 'Location') });
  });

  // ---- expense categories ----
  r.get('/expense-categories', requireAuth, async (req, res) => {
    sendList(req, res, await rows(db, sql`
      select c.*, a.code as account_code, a.name as account_name
        from expense_categories c join accounts a on a.id = c.account_id order by c.name`));
  });
  r.post('/expense-categories', requirePerm('masters:manage', 'accounts:write'), async (req, res) => {
    const body = zNameActive.extend({ account_id: zId }).parse(req.body);
    const [row] = await db.insert(expenseCategories)
      .values({ name: body.name, active: body.active ?? true, accountId: body.account_id, createdBy: req.user!.id }).returning();
    res.status(201).json({ data: row });
  });

  // ---- price lists ----
  r.get('/price-lists', requireAuth, async (req, res) => {
    sendList(req, res, await db.select().from(priceLists).orderBy(asc(priceLists.name)));
  });
  r.post('/price-lists', requirePerm('pricelists:write'), async (req, res) => {
    const body = z.object({ name: zText(100), base_price: z.enum(['retail', 'dealer']), tax_inclusive: z.boolean() }).parse(req.body);
    const [row] = await db.insert(priceLists)
      .values({ name: body.name, basePrice: body.base_price, taxInclusive: body.tax_inclusive, createdBy: req.user!.id }).returning();
    res.status(201).json({ data: row });
  });
  r.patch('/price-lists/:id', requirePerm('pricelists:write'), async (req, res) => {
    const body = z.object({ name: zText(100), tax_inclusive: z.boolean(), active: z.boolean() }).partial().parse(req.body);
    const [row] = await db.update(priceLists)
      .set({ name: body.name, taxInclusive: body.tax_inclusive, active: body.active, updatedAt: new Date() })
      .where(eq(priceLists.id, zId.parse(req.params.id))).returning();
    res.json({ data: must(row, 'Price list') });
  });
  // The founder approves price lists (PRD section 5).
  r.post('/price-lists/:id/approve', requirePerm('pricelists:approve'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const row = await inTx(db, req, async (ctx) => {
      const [pl] = await ctx.tx.update(priceLists)
        .set({ approvedBy: ctx.user!.id, approvedAt: new Date(), updatedAt: new Date() })
        .where(eq(priceLists.id, id)).returning();
      must(pl, 'Price list');
      await audit(ctx, 'price_list', id, 'approve', null, { approvedBy: ctx.user!.id });
      return pl;
    });
    res.json({ data: row });
  });
  r.get('/price-lists/:id/items', requireAuth, async (req, res) => {
    const id = zId.parse(req.params.id);
    sendList(req, res, await rows(db, sql`
      select pli.id, pli.item_id, i.sku, i.name, pli.rate
        from price_list_items pli join items i on i.id = pli.item_id
       where pli.price_list_id = ${id} order by i.name`));
  });
  r.put('/price-lists/:id/items', requirePerm('pricelists:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const body = z.object({ items: z.array(z.object({ item_id: zId, rate: zMoney.nullable() })).max(2000) }).parse(req.body);
    await inTx(db, req, async (ctx) => {
      must((await ctx.tx.select().from(priceLists).where(eq(priceLists.id, id)))[0], 'Price list');
      for (const it of body.items) {
        if (it.rate === null) {
          await ctx.tx.execute(sql`delete from price_list_items where price_list_id = ${id} and item_id = ${it.item_id}`);
        } else {
          await ctx.tx.insert(priceListItems)
            .values({ priceListId: id, itemId: it.item_id, rate: it.rate, createdBy: ctx.user!.id })
            .onConflictDoUpdate({ target: [priceListItems.priceListId, priceListItems.itemId], set: { rate: it.rate, updatedAt: new Date() } });
        }
      }
      // A changed price list needs the founder's approval again.
      await ctx.tx.update(priceLists).set({ approvedBy: null, approvedAt: null, updatedAt: new Date() }).where(eq(priceLists.id, id));
      await audit(ctx, 'price_list', id, 'update_items', null, body.items);
    });
    res.json({ ok: true });
  });

  r.get('/users-lite', requireAuth, async (_req, res) => {
    res.json({ data: await db.select({ id: users.id, name: users.name, role: users.role }).from(users)
      .where(eq(users.active, true)).orderBy(desc(users.createdAt)) });
  });
  return r;
}
