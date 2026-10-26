import { and, eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { UNIT_STATUSES, istDate } from '@radcore/shared';
import { audit } from '../core/audit';
import { requirePerm } from '../core/auth';
import { batchFor, genealogy, unitEvent } from '../core/units';
import { rows, type DB } from '../db/client';
import { items, units } from '../db/schema';
import { badRequest, conflict, must } from '../lib/errors';
import { emptyToNull, inTx, sendList, zDate, zId, zListQuery, zText } from '../lib/http';

/**
 * Serialised units as people look them up: by serial, by where they are and what state they are in,
 * what each is made of (genealogy), and the batteries waiting for their storage charge. Units come
 * into being and move through the documents (goods receipt, delivery, transfer, adjustment; see
 * core/units.ts); here they are only described: fitted inside another, given their BPAN and
 * firmware, charged.
 */

/** In our hands, whatever its state (the opposite of sold, returned to the supplier, scrapped). */
const OURS = sql`u.status not in ('sold', 'rtv', 'scrapped')`;

/** Batteries late for their storage charge: N days (the item's charge_every_days) since the last one, or since it was made or came in. */
export async function chargeDue(db: DB, limit = 500) {
  return rows<{ id: string; serial_no: string; item_name: string; location: string | null; last_charged: string; due_on: string; days_late: number }>(db, sql`
    select u.id, u.serial_no, i.name as item_name, coalesce(l.name, pl.name) as location,
           coalesce(u.last_charged_on, u.mfg_date, (u.created_at at time zone 'Asia/Kolkata')::date)::text as last_charged,
           (coalesce(u.last_charged_on, u.mfg_date, (u.created_at at time zone 'Asia/Kolkata')::date) + i.charge_every_days)::text as due_on,
           (${istDate()}::date - (coalesce(u.last_charged_on, u.mfg_date, (u.created_at at time zone 'Asia/Kolkata')::date) + i.charge_every_days))::int as days_late
      from units u join items i on i.id = u.item_id
      left join locations l on l.id = u.location_id
      left join units p on p.id = u.parent_unit_id left join locations pl on pl.id = p.location_id
     where i.charge_every_days is not null and ${OURS}
       and coalesce(u.last_charged_on, u.mfg_date, (u.created_at at time zone 'Asia/Kolkata')::date) + i.charge_every_days <= ${istDate()}::date
     order by days_late desc, u.serial_no limit ${limit}`);
}

export function unitsRouter(db: DB) {
  const r = Router();

  /** Units, newest first: search by serial or BPAN, filter by item, place and status; in_stock for the ones that can be picked. */
  r.get('/', requirePerm('units:read'), async (req, res) => {
    const q = zListQuery.extend({
      item_id: zId.optional(), location_id: zId.optional(), status: z.enum(UNIT_STATUSES).optional(),
      in_stock: z.enum(['true', 'false']).optional(),
    }).parse(req.query);
    const like = q.q ? `%${q.q.toUpperCase()}%` : null;
    const data = await rows(db, sql`
      select u.id, u.serial_no, u.status, u.bpan, u.firmware_version, u.mfg_date, u.sold_on, u.last_charged_on,
             u.item_id, i.sku, i.name as item_name, u.location_id, l.name as location, l.type as location_type,
             u.parent_unit_id, p.serial_no as parent_serial, b.batch_no,
             (select count(*)::int from units c where c.parent_unit_id = u.id) as components
        from units u join items i on i.id = u.item_id
        left join locations l on l.id = u.location_id
        left join units p on p.id = u.parent_unit_id
        left join batches b on b.id = u.batch_id
       where (${like}::text is null or u.serial_no like ${like} or u.bpan like ${like} or p.serial_no like ${like})
         and (${q.item_id ?? null}::uuid is null or u.item_id = ${q.item_id ?? null}::uuid)
         and (${q.location_id ?? null}::uuid is null or u.location_id = ${q.location_id ?? null}::uuid)
         and (${q.status ?? null}::text is null or u.status::text = ${q.status ?? null})
         and (${q.in_stock ?? null}::text is null or (u.location_id is not null and u.status in ('available', 'demo')) = (${q.in_stock ?? null} = 'true'))
       order by u.created_at desc, u.serial_no
       limit ${q.limit} offset ${q.offset}`);
    sendList(req, res, data, 'units');
  });

  /** The owner's daily list: batteries whose storage charge is due. */
  r.get('/charge-due', requirePerm('units:read'), async (req, res) => {
    sendList(req, res, await chargeDue(db), 'battery-charges-due');
  });

  r.get('/batches', requirePerm('units:read'), async (req, res) => {
    const q = z.object({ item_id: zId.optional() }).parse(req.query);
    sendList(req, res, await rows(db, sql`
      select b.*, i.name as item_name, s.name as supplier_name, (select count(*)::int from units u where u.batch_id = b.id) as units
        from batches b join items i on i.id = b.item_id left join parties s on s.id = b.supplier_id
       where (${q.item_id ?? null}::uuid is null or b.item_id = ${q.item_id ?? null}::uuid)
       order by b.created_at desc limit 500`), 'batches');
  });

  /**
   * What a unit is part of and what is fitted in it, by serial: up to the vehicle at the top and
   * down through every component. A serial is unique per item, so if two items share it, say which.
   */
  r.get('/:serial/genealogy', requirePerm('units:read'), async (req, res) => {
    const serial = z.string().trim().min(1).max(60).parse(req.params.serial).toUpperCase();
    const q = z.object({ item_id: zId.optional() }).parse(req.query);
    const matches = await rows<{ id: string; item_id: string; item_name: string }>(db, sql`
      select u.id, u.item_id, i.name as item_name from units u join items i on i.id = u.item_id
       where u.serial_no = ${serial} and (${q.item_id ?? null}::uuid is null or u.item_id = ${q.item_id ?? null}::uuid)`);
    if (matches.length === 0) throw must(null, `Unit ${serial}`);
    if (matches.length > 1) {
      throw conflict(`${matches.length} items have a unit with serial ${serial}: ${matches.map((m) => m.item_name).join(', ')}. Say which with item_id.`,
        { items: matches.map((m) => ({ item_id: m.item_id, item_name: m.item_name })) });
    }
    const [unit] = await rows(db, sql`
      select u.*, i.name as item_name, i.sku, l.name as location from units u join items i on i.id = u.item_id
        left join locations l on l.id = u.location_id where u.id = ${matches[0]!.id}`);
    res.json({ data: { unit, ...(await genealogy(db, matches[0]!.id)) } });
  });

  /** One unit: what it is, where it is, what it is made of, and everything that happened to it. */
  r.get('/:id', requirePerm('units:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const [unit] = await rows(db, sql`
      select u.*, i.name as item_name, i.sku, i.charge_every_days, l.name as location, l.type as location_type, b.batch_no, b.chemistry, b.weight_kg,
             s.name as supplier_name, inv.invoice_no as sold_invoice_no, inv.id as sold_invoice_id, inv.party_name as sold_to
        from units u join items i on i.id = u.item_id
        left join locations l on l.id = u.location_id
        left join batches b on b.id = u.batch_id left join parties s on s.id = b.supplier_id
        left join invoice_lines il on il.id = u.sold_invoice_line_id left join invoices inv on inv.id = il.invoice_id
       where u.id = ${id}`);
    must(unit, 'Unit');
    const events = await rows(db, sql`
      select e.id, e.event, e.at, e.from_status, e.to_status, fl.name as from_location, tl.name as to_location, e.ref_type, e.ref_id, e.note,
             us.name as user_name
        from unit_events e left join locations fl on fl.id = e.from_location_id left join locations tl on tl.id = e.to_location_id
        left join users us on us.id = e.created_by
       where e.unit_id = ${id} order by e.id desc`);
    const jobs = await rows(db, sql`select id, job_no, status, created_at, complaint from job_cards where unit_id = ${id} order by created_at desc`);
    res.json({ data: { ...unit, events, jobs, ...(await genealogy(db, id)) } });
  });

  /**
   * Describe a unit: its BPAN, firmware and dates, and what it is fitted in. Only a unit that is not
   * on a shelf of its own can be fitted (a component recorded on its vehicle); taking stock parts out
   * of the shelf to build with is the job of work orders, which come later.
   */
  r.patch('/:id', requirePerm('units:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      bpan: emptyToNull(z.string().trim().toUpperCase().length(21, 'a BPAN has 21 characters')).optional(),
      firmware_version: emptyToNull(z.string().trim().max(60)).optional(),
      mfg_date: emptyToNull(zDate).optional(),
      parent_unit_id: emptyToNull(zId).optional(),
    }).parse(req.body);
    const updated = await inTx(db, req, async (ctx) => {
      const [before] = await ctx.tx.select().from(units).where(eq(units.id, id)).for('update');
      must(before, 'Unit');
      const patch: Partial<typeof units.$inferInsert> = { updatedAt: new Date() };
      if (b.bpan !== undefined) patch.bpan = b.bpan;
      if (b.firmware_version !== undefined) patch.firmwareVersion = b.firmware_version;
      if (b.mfg_date !== undefined) patch.mfgDate = b.mfg_date;
      if (b.parent_unit_id !== undefined && b.parent_unit_id !== before!.parentUnitId) {
        if (b.parent_unit_id) {
          if (before!.locationId) throw conflict(`${before!.serialNo} is on the shelf as stock of its own; it cannot be recorded as fitted in another unit`);
          const [parent] = await ctx.tx.select().from(units).where(eq(units.id, b.parent_unit_id)).for('update');
          must(parent, 'Unit to fit it in');
          const { descendants } = await genealogy(ctx.tx, id);
          if (parent!.id === id || descendants.some((d: any) => d.id === parent!.id)) throw badRequest('A unit cannot be fitted inside itself or one of its own parts');
          patch.parentUnitId = parent!.id;
          patch.status = parent!.status;
          await unitEvent(ctx, { unitId: id, event: 'fitted', from: { locationId: null, status: before!.status }, to: { locationId: null, status: parent!.status }, refType: 'unit', refId: parent!.id, note: `Fitted in ${parent!.serialNo}` });
        } else {
          patch.parentUnitId = null;
          await unitEvent(ctx, { unitId: id, event: 'removed', refType: 'unit', refId: before!.parentUnitId, note: 'Taken out of its parent' });
        }
      }
      const [row] = await ctx.tx.update(units).set(patch).where(eq(units.id, id)).returning();
      if (b.bpan !== undefined || b.firmware_version !== undefined || b.mfg_date !== undefined) {
        await unitEvent(ctx, { unitId: id, event: 'updated', note: Object.keys(b).filter((k) => k !== 'parent_unit_id').join(', ') });
      }
      await audit(ctx, 'unit', id, 'update', before, row);
      return row;
    });
    res.json({ data: updated });
  });

  /** Record a component inside a unit (the battery pack in a vehicle, the motor in it): it gets its own serial and history. */
  r.post('/:id/components', requirePerm('units:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({
      item_id: zId, serial_no: zText(60).transform((s) => s.toUpperCase()),
      bpan: emptyToNull(z.string().trim().toUpperCase().length(21, 'a BPAN has 21 characters')).optional(),
      firmware_version: emptyToNull(z.string().trim().max(60)).optional(),
      mfg_date: emptyToNull(zDate).optional(),
      batch_no: emptyToNull(z.string().trim().max(60)).optional(),
    }).parse(req.body);
    const made = await inTx(db, req, async (ctx) => {
      const [parent] = await ctx.tx.select().from(units).where(eq(units.id, id)).for('update');
      must(parent, 'Unit');
      const [item] = await ctx.tx.select().from(items).where(eq(items.id, b.item_id));
      must(item, 'Item');
      const [taken] = await ctx.tx.select({ id: units.id }).from(units).where(and(eq(units.itemId, b.item_id), eq(units.serialNo, b.serial_no)));
      if (taken) throw conflict(`There is already a ${item!.name} with serial ${b.serial_no}`);
      const batchId = b.batch_no ? await batchFor(ctx, item!.id, { batchNo: b.batch_no, mfgDate: b.mfg_date }) : null;
      const [unit] = await ctx.tx.insert(units).values({
        itemId: item!.id, serialNo: b.serial_no, parentUnitId: parent!.id, status: parent!.status, locationId: null,
        bpan: b.bpan ?? null, firmwareVersion: b.firmware_version ?? null, mfgDate: b.mfg_date ?? null, batchId,
        soldOn: parent!.soldOn, createdBy: ctx.user?.id ?? null,
      }).returning();
      await unitEvent(ctx, { unitId: unit!.id, event: 'fitted', to: { locationId: null, status: parent!.status }, refType: 'unit', refId: parent!.id, note: `Recorded inside ${parent!.serialNo}` });
      await audit(ctx, 'unit', unit!.id, 'create', null, unit);
      return unit;
    });
    res.status(201).json({ data: made });
  });

  /** A battery had its storage charge (today unless a date is given). */
  r.post('/:id/charged', requirePerm('units:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ charged_on: zDate.optional(), note: emptyToNull(z.string().trim().max(300)).optional() }).parse(req.body ?? {});
    const on = b.charged_on ?? istDate();
    if (on > istDate()) throw badRequest('The charge date cannot be in the future');
    const row = await inTx(db, req, async (ctx) => {
      const [u] = await ctx.tx.update(units).set({ lastChargedOn: on, updatedAt: new Date() }).where(eq(units.id, id)).returning();
      must(u, 'Unit');
      await unitEvent(ctx, { unitId: id, event: 'charged', note: b.note ?? `Storage charge on ${on}` });
      return u;
    });
    res.json({ data: row });
  });

  return r;
}
