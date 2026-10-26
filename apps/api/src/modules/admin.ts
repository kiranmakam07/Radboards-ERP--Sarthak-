import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { PERMISSIONS, ROLES, STATE_CODES, can, isIsoDate, istDate, rolesFor, stateCodeFromGstin, type Permission } from '@radcore/shared';
import { config } from '../config';
import { audit } from '../core/audit';
import {
  clearSessionCookie, hashPassword, login, logout, requireAuth, requirePerm, revokeUserSessions, setSessionCookie,
} from '../core/auth';
import { getSetting, loadPermissionOverrides, setSetting, type CompanyProfile } from '../core/settings';
import { rows, type DB } from '../db/client';
import {
  branches, campaigns, entities, expenseCategories, itemCategories, leadSources, locations, lostReasons, numberSeries, priceListItems,
  priceLists, taxRates, users,
} from '../db/schema';
import { badRequest, forbidden, must } from '../lib/errors';
import {
  emptyToNull, inTx, sendList, zAddress, zDate, zGstin, zGstRate, zHttpUrl, zId, zMoney, zPhone, zStateCode, zText,
} from '../lib/http';
import { toWorkbook, type Sheet } from '../lib/xlsx';

/**
 * Four routers the rest of the system leans on:
 *   authRouter      signing in and out, and what the screens need to know about the session
 *   usersRouter     who can sign in, and in which role
 *   settingsRouter  company profile, period lock, stock rule, who holds which permission, audit trail
 *   mastersRouter   the small lists every module reads (lead sources, lost reasons, campaigns, item
 *                   categories, locations, expense categories, price lists), and the download of all
 *                   the master data as one workbook
 * The larger masters have modules of their own: items.ts, parties.ts, and employees in hr.ts.
 */

// ---------------------------------------------------------------------------
// Signing in and out
// ---------------------------------------------------------------------------
const zPassword = z.string().min(8, 'must be at least 8 characters').max(200);

/** What the screens need to know about this installation, sent along with who is signed in. */
const sessionExtras = async (db: DB) => ({
  sample_data: await getSetting(db, 'sample_data'),
  max_upload_mb: Math.floor(config.maxUploadBytes / 1024 / 1024),
  /** True when messages can be sent to a lead from inside the app (the WhatsApp number is connected). */
  whatsapp_send: Boolean(config.whatsappPhoneNumberId && config.whatsappAccessToken),
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

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Settings, permissions and the audit trail
// ---------------------------------------------------------------------------
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
        discount_limits: await getSetting(db, 'discount_limits'),
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
    const fromGstin = body.gstin ? stateCodeFromGstin(body.gstin) : null;
    if (fromGstin && fromGstin !== body.state_code) {
      throw badRequest(`State code ${body.state_code} does not match the GSTIN (${fromGstin})`);
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

  /** The biggest discount off the price list each role may give without approval, in %. */
  r.put('/discount-limits', requirePerm('settings:manage'), async (req, res) => {
    const body = z.object({ discount_limits: z.record(z.enum(ROLES), z.number().min(0).max(100)) }).parse(req.body);
    await inTx(db, req, async (ctx) => {
      const before = await getSetting(ctx.tx, 'discount_limits');
      await setSetting(ctx.tx, 'discount_limits', body.discount_limits, ctx.user!.id);
      await audit(ctx, 'settings', 'discount_limits', 'update', before, body.discount_limits);
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

  /** DPDP (brief P3): who opened which customer's full record (a lead or a party), newest first. */
  r.get('/access-log', requirePerm('audit:read'), async (req, res) => {
    const q = z.object({ record_type: z.enum(['lead', 'party']).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(req.query);
    sendList(req, res, await rows(db, sql`
      select a.id, a.record_type, a.record_id, a.at, u.name as user_name, u.role,
             coalesce(l.name, p.name) as record_name, coalesce(l.lead_no, p.party_type::text) as record_ref
        from access_log a left join users u on u.id = a.user_id
        left join leads l on a.record_type = 'lead' and l.id = a.record_id
        left join parties p on a.record_type = 'party' and p.id = a.record_id
       where (${q.record_type ?? null}::text is null or a.record_type = ${q.record_type ?? null})
       order by a.id desc limit ${q.limit}`), 'access-log');
  });
  return r;
}

// ---------------------------------------------------------------------------
// Masters: the small lists every module reads
// ---------------------------------------------------------------------------
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

  // ---- GST rate history ----
  /** Rate changes by HSN, newest first: what each code carries from which day (core/taxrates.ts). */
  r.get('/tax-rates', requireAuth, async (req, res) => {
    sendList(req, res, await db.select().from(taxRates).orderBy(asc(taxRates.hsn), desc(taxRates.effectiveFrom)), 'tax-rates');
  });
  r.post('/tax-rates', requirePerm('masters:manage'), async (req, res) => {
    const pctOrNull = emptyToNull(z.coerce.number().min(0).max(300)).optional();
    const b = z.object({
      hsn: z.string().trim().regex(/^\d{2,8}$/, 'an HSN or SAC code: 2 to 8 digits'), gst_rate: zGstRate,
      cess_rate: z.coerce.number().min(0).max(300).default(0), bcd_rate: pctOrNull, sws_rate: pctOrNull,
      effective_from: zDate, note: emptyToNull(z.string().trim().max(300)).optional(),
    }).parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const [made] = await ctx.tx.insert(taxRates).values({
        hsn: b.hsn, gstRate: b.gst_rate, cessRate: String(b.cess_rate), bcdRate: b.bcd_rate == null ? null : String(b.bcd_rate),
        swsRate: b.sws_rate == null ? null : String(b.sws_rate), effectiveFrom: b.effective_from, note: b.note ?? null, createdBy: ctx.user!.id,
      }).returning();
      await audit(ctx, 'tax_rate', made!.id, 'create', null, made);
      return made;
    });
    res.status(201).json({ data: row });
  });

  // ---- legal entities and branches ----
  /** The companies RadCore keeps books for (the first is the company profile), each with its branches. */
  r.get('/entities', requireAuth, async (req, res) => {
    const list = await db.select().from(entities).orderBy(desc(entities.isDefault), asc(entities.createdAt));
    const all = await db.select().from(branches).orderBy(asc(branches.name));
    sendList(req, res, list.map((e) => ({ ...e, branches: all.filter((b) => b.entityId === e.id) })), 'entities');
  });
  const zEntity = z.object({
    legal_name: zText(200), gstin: emptyToNull(zGstin).optional(),
    state_code: zStateCode.refine((c) => Boolean(STATE_CODES[c]), 'unknown state code'), address: zAddress.default({}),
    code: z.string().trim().toUpperCase().regex(/^[A-Z]$/, 'one letter, put in front of its document numbers'),
  });
  r.post('/entities', requirePerm('settings:manage'), async (req, res) => {
    const b = zEntity.parse(req.body);
    const fromGstin = b.gstin ? stateCodeFromGstin(b.gstin) : null;
    if (fromGstin && fromGstin !== b.state_code) throw badRequest(`State code ${b.state_code} does not match the GSTIN (${fromGstin})`);
    const row = await inTx(db, req, async (ctx) => {
      const [e] = await ctx.tx.insert(entities).values({
        legalName: b.legal_name, gstin: b.gstin ?? null, stateCode: b.state_code, address: b.address, code: b.code, createdBy: ctx.user!.id,
      }).returning();
      await audit(ctx, 'entity', e!.id, 'create', null, e);
      return e;
    });
    res.status(201).json({ data: row });
  });
  r.post('/entities/:id/branches', requirePerm('settings:manage'), async (req, res) => {
    const entityId = zId.parse(req.params.id);
    const b = z.object({
      name: zText(120), gstin: emptyToNull(zGstin).optional(),
      state_code: zStateCode.refine((c) => Boolean(STATE_CODES[c]), 'unknown state code'), address: zAddress.default({}),
    }).parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const [e] = await ctx.tx.select().from(entities).where(eq(entities.id, entityId));
      must(e, 'Legal entity');
      const [made] = await ctx.tx.insert(branches).values({
        entityId, name: b.name, gstin: b.gstin ?? null, stateCode: b.state_code, address: b.address, createdBy: ctx.user!.id,
      }).returning();
      await audit(ctx, 'branch', made!.id, 'create', null, made);
      return made;
    });
    res.status(201).json({ data: row });
  });

  // ---- locations ----
  r.get('/locations', requireAuth, async (req, res) => {
    sendList(req, res, await db.select().from(locations).orderBy(asc(locations.createdAt)));
  });
  r.post('/locations', requirePerm('masters:manage'), async (req, res) => {
    // Job work places are made by the system, one per job worker; every other kind can be added here.
    const body = zNameActive.extend({ type: z.enum(['stores', 'showroom', 'rejected', 'service_bay', 'demo', 'franchise', 'in_transit']) }).parse(req.body);
    const [row] = await db.insert(locations).values({ ...body, createdBy: req.user!.id }).returning();
    res.status(201).json({ data: row });
  });
  r.patch('/locations/:id', requirePerm('masters:manage'), async (req, res) => {
    const body = zNameActive.partial().parse(req.body);
    const [place] = await db.select().from(locations).where(eq(locations.id, zId.parse(req.params.id)));
    // Job work runs through its own place: it cannot be switched off from the list.
    if (place?.type === 'job_work' && body.active === false) throw badRequest('The place for stock with job workers is used by every job work challan and stays on');
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

  // ---- the masters as a whole ----
  /** How many of each master there are and when one was last changed, for the Masters screen. */
  r.get('/summary', requirePerm('masters:manage'), async (_req, res) => {
    const [data] = await rows(db, sql`
      select (select count(*)::int from items where active) as items,
             (select count(*)::int from items where not active) as items_inactive,
             (select max(updated_at) from items) as items_changed_at,
             (select count(*)::int from parties where active and party_type <> 'supplier') as customers,
             (select max(updated_at) from parties where party_type <> 'supplier') as customers_changed_at,
             (select count(*)::int from parties where active and party_type = 'supplier') as suppliers,
             (select max(updated_at) from parties where party_type = 'supplier') as suppliers_changed_at,
             (select count(*)::int from employees where status = 'active') as employees,
             (select count(*)::int from employees where status = 'left') as employees_left,
             (select max(updated_at) from employees) as employees_changed_at`);
    res.json({ data });
  });

  /**
   * Every master in one Excel workbook, a sheet each: enough to check the set-up at a glance or to
   * carry it to another system. Salaries and bank accounts are on the employees sheet, so that
   * sheet is only included for someone who may change employees.
   */
  r.get('/export', requirePerm('masters:manage'), async (req, res) => {
    const role = req.user!.role;
    const sheets: Sheet[] = [];
    sheets.push({ name: 'Items', rows: await rows(db, sql`
      select i.sku, i.name, replace(i.item_type::text, '_', ' ') as type, c.name as category, i.hsn_sac, i.gst_rate, i.unit, i.purchase_cost, i.mrp,
             i.retail_price, i.dealer_price, i.reorder_level, i.barcode, i.is_stock_item as stock_item, i.active
        from items i left join item_categories c on c.id = i.category_id order by i.name`),
      columns: ['sku', 'name', 'type', 'category', 'hsn_sac', 'gst_rate', 'unit', 'purchase_cost', 'mrp', 'retail_price', 'dealer_price',
        'reorder_level', 'barcode', 'stock_item', 'active'] });
    const partyRows = (supplier: boolean) => rows(db, sql`
      select p.party_type as type, p.name, p.phone, p.email, p.gstin, p.state_code,
             p.billing_address->>'line1' as address, p.billing_address->>'city' as city, p.billing_address->>'pincode' as pincode,
             pl.name as price_list, p.credit_limit, p.payment_terms_days, p.active
        from parties p left join price_lists pl on pl.id = p.price_list_id
       where (p.party_type = 'supplier') = ${supplier} order by p.name`);
    sheets.push({ name: 'Customers', rows: (await partyRows(false)).map((p) => ({ ...p, state: STATE_CODES[String(p.state_code)] ?? null })),
      columns: ['type', 'name', 'phone', 'email', 'gstin', 'state_code', 'state', 'address', 'city', 'pincode', 'price_list', 'credit_limit',
        'payment_terms_days', 'active'] });
    sheets.push({ name: 'Suppliers', rows: (await partyRows(true)).map((p) => ({ ...p, state: STATE_CODES[String(p.state_code)] ?? null })),
      columns: ['name', 'phone', 'email', 'gstin', 'state_code', 'state', 'address', 'city', 'pincode', 'payment_terms_days', 'active'] });
    if (can(role, 'employees:manage')) {
      sheets.push({ name: 'Employees', rows: await rows(db, sql`
        select e.employee_no, e.name, e.phone, e.email, e.department, e.designation, replace(e.employment_type::text, '_', ' ') as employment_type,
               e.join_date, e.monthly_salary,
               e.annual_leave_days, e.pf_applicable as pf, e.esic_applicable as esic, e.pt_monthly as professional_tax_monthly, e.tds_monthly,
               e.bank_account_no, e.bank_ifsc, u.name as sign_in, u.role as sign_in_role, e.status, e.left_on
          from employees e left join users u on u.id = e.user_id order by e.employee_no`),
        columns: ['employee_no', 'name', 'phone', 'email', 'department', 'designation', 'employment_type', 'join_date', 'monthly_salary',
          'annual_leave_days', 'pf', 'esic', 'professional_tax_monthly', 'tds_monthly', 'bank_account_no', 'bank_ifsc', 'sign_in', 'sign_in_role',
          'status', 'left_on'] });
    }
    await inTx(db, req, (ctx) => audit(ctx, 'masters', 'all', 'export', null, { sheets: sheets.map((s) => `${s.name}: ${s.rows.length}`) }));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="radcore-masters-${istDate()}.xlsx"`);
    res.send(toWorkbook(sheets));
  });

  r.get('/users-lite', requireAuth, async (_req, res) => {
    res.json({ data: await db.select({ id: users.id, name: users.name, role: users.role }).from(users)
      .where(eq(users.active, true)).orderBy(desc(users.createdAt)) });
  });
  return r;
}
