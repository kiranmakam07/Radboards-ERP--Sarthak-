import { and, asc, eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { CHANNELS, ITEM_TYPES, addDays, istDate } from '@radcore/shared';
import { audit } from '../core/audit';
import { requirePerm } from '../core/auth';
import { rows, type DB } from '../db/client';
import { channelItemMap, itemImages, items, priceListItems, priceLists } from '../db/schema';
import { badRequest, must } from '../lib/errors';
import { emptyToNull, inTx, sendList, zCessRate, zGstRate, zLink, zId, zListQuery, zMoney, zQtyNonNeg, zText } from '../lib/http';

/**
 * The item master: what we buy, make and sell, with HSN, GST rate, unit, prices, pictures and the
 * listing each item corresponds to on an online channel. It also answers the one pricing question
 * every sale asks: which price list applies to this customer, and what is this item's rate on it
 * (priceListFor, priceFor).
 */

export type PriceList = typeof priceLists.$inferSelect;
export type Item = typeof items.$inferSelect;

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------
/** Price list for a sale: the party's own list, else the default for its type (dealer / retail). */
export async function priceListFor(tx: DB, party: { priceListId: string | null; partyType: string } | null): Promise<PriceList> {
  if (party?.priceListId) {
    const [pl] = await tx.select().from(priceLists).where(eq(priceLists.id, party.priceListId));
    if (pl) return pl;
  }
  const base = party?.partyType === 'dealer' ? 'dealer' : 'retail';
  const [pl] = await tx
    .select()
    .from(priceLists)
    .where(and(eq(priceLists.basePrice, base), eq(priceLists.active, true)))
    .orderBy(asc(priceLists.createdAt))
    .limit(1);
  if (!pl) throw badRequest(`No active ${base} price list is set up`);
  return pl;
}

/** Rate for an item on a price list: the override row if there is one, else the item's default price. */
export async function priceFor(tx: DB, item: Item, priceList: PriceList): Promise<string> {
  const [override] = await tx
    .select({ rate: priceListItems.rate })
    .from(priceListItems)
    .where(and(eq(priceListItems.priceListId, priceList.id), eq(priceListItems.itemId, item.id)));
  if (override) return override.rate;
  return priceList.basePrice === 'dealer' ? item.dealerPrice : item.retailPrice;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const zItem = z.object({
  sku: zText(60).transform((s) => s.toUpperCase()),
  name: zText(200),
  item_type: z.enum(ITEM_TYPES),
  category_id: emptyToNull(zId).optional(),
  hsn_sac: emptyToNull(z.string().regex(/^\d{4,8}$/, 'HSN/SAC must be 4 to 8 digits')).optional(),
  gst_rate: zGstRate,
  cess_rate: zCessRate.default('0'),
  unit: zText(20).default('Nos'),
  purchase_cost: zMoney.default('0'),
  mrp: zMoney.default('0'),
  retail_price: zMoney.default('0'),
  dealer_price: zMoney.default('0'),
  reorder_level: emptyToNull(zQtyNonNeg).optional(),
  barcode: emptyToNull(z.string().trim().max(60)).optional(),
  active: z.boolean().optional(),
});

function toRow(b: Partial<z.infer<typeof zItem>>) {
  return {
    sku: b.sku, name: b.name, itemType: b.item_type, categoryId: b.category_id, hsnSac: b.hsn_sac, gstRate: b.gst_rate, cessRate: b.cess_rate,
    unit: b.unit, purchaseCost: b.purchase_cost, mrp: b.mrp, retailPrice: b.retail_price, dealerPrice: b.dealer_price,
    reorderLevel: b.reorder_level, barcode: b.barcode, active: b.active,
    // Services are never stock items (PRD 8.4).
    ...(b.item_type ? { isStockItem: b.item_type !== 'service' } : {}),
  };
}

export function itemsRouter(db: DB) {
  const r = Router();

  r.get('/', requirePerm('items:read'), async (req, res) => {
    const q = zListQuery.extend({
      type: z.enum(ITEM_TYPES).optional(),
      active: z.enum(['true', 'false', 'all']).default('true'),
      category_id: zId.optional(),
    }).parse(req.query);
    const like = q.q ? `%${q.q}%` : null;
    const data = await rows(db, sql`
      select i.*, c.name as category_name,
             (select im.url from item_images im where im.item_id = i.id order by im.sort, im.created_at limit 1) as image_url,
             coalesce(s.sellable, 0) as on_hand, coalesce(s.showroom, 0) as showroom_qty,
             coalesce(s.stores, 0) as stores_qty, coalesce(s.rejected, 0) as rejected_qty
        from items i
        left join item_categories c on c.id = i.category_id
        left join (
          select m.item_id,
                 sum(m.qty) filter (where l.type in ('stores', 'showroom')) as sellable,
                 sum(m.qty) filter (where l.type = 'showroom') as showroom,
                 sum(m.qty) filter (where l.type = 'stores') as stores,
                 sum(m.qty) filter (where l.type = 'rejected') as rejected
            from stock_movements m join locations l on l.id = m.location_id
           group by m.item_id
        ) s on s.item_id = i.id
       where (${like}::text is null or i.name ilike ${like} or i.sku ilike ${like} or i.barcode = ${q.q ?? null})
         and (${q.type ?? null}::text is null or i.item_type::text = ${q.type ?? null})
         and (${q.category_id ?? null}::uuid is null or i.category_id = ${q.category_id ?? null}::uuid)
         and (${q.active} = 'all' or i.active = (${q.active} = 'true'))
       order by i.name
       limit ${q.limit} offset ${q.offset}`);
    sendList(req, res, data, 'items');
  });

  /** Exact barcode/SKU scan for the quick bill. */
  r.get('/lookup', requirePerm('items:read'), async (req, res) => {
    const code = z.string().trim().min(1).parse(req.query.code);
    const [item] = await rows(db, sql`
      select * from items where active and (barcode = ${code} or sku = ${code.toUpperCase()}) limit 1`);
    res.json({ data: must(item, 'Item') });
  });

  r.get('/:id', requirePerm('items:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const [item] = await db.select().from(items).where(eq(items.id, id));
    must(item, 'Item');
    const stock = await rows(db, sql`
      select l.id as location_id, l.name as location, l.type, coalesce(s.qty, 0) as qty
        from locations l left join v_stock_on_hand s on s.location_id = l.id and s.item_id = ${id}
       order by l.created_at`);
    const [val] = await rows(db, sql`select qty, value, avg_cost from v_item_valuation where item_id = ${id}`);
    // What is happening with it: sold and bought in the last 90 days, and what is promised either way.
    const since = addDays(istDate(), -90);
    const [activity] = await rows(db, sql`
      select
        (select coalesce(sum(case when v.doc_type = 'credit_note' then -l.qty else l.qty end), 0)
           from invoice_lines l join invoices v on v.id = l.invoice_id
          where l.item_id = ${id} and v.status = 'issued' and v.invoice_date >= ${since}::date) as sold_qty,
        (select coalesce(sum(case when v.doc_type = 'credit_note' then -l.taxable_value else l.taxable_value end), 0)
           from invoice_lines l join invoices v on v.id = l.invoice_id
          where l.item_id = ${id} and v.status = 'issued' and v.invoice_date >= ${since}::date) as sold_value,
        (select coalesce(sum(m.qty), 0) from stock_movements m
          where m.item_id = ${id} and m.movement_type = 'purchase_in' and m.posted_at >= ${since}::date) as bought_qty,
        (select coalesce(sum(l.qty - l.delivered_qty), 0) from sales_order_lines l join sales_orders o on o.id = l.order_id
          where l.item_id = ${id} and o.status = 'confirmed') as to_deliver,
        (select coalesce(sum(l.qty - l.received_qty), 0) from purchase_order_lines l join purchase_orders po on po.id = l.purchase_order_id
          where l.item_id = ${id} and po.status in ('sent', 'partly_received')) as to_receive`);
    const rates = await rows(db, sql`
      select pl.id, pl.name, r.rate from price_list_items r join price_lists pl on pl.id = r.price_list_id
       where r.item_id = ${id} order by pl.name`);
    const movements = await rows(db, sql`
      select m.id, m.posted_at, m.movement_type, m.qty, m.unit_cost, m.reason, l.name as location
        from stock_movements m join locations l on l.id = m.location_id
       where m.item_id = ${id} order by m.posted_at desc, m.id desc limit 15`);
    res.json({
      data: {
        ...item,
        stock,
        activity,
        price_list_rates: rates,
        movements,
        valuation: val ?? { qty: '0', value: '0', avg_cost: null },
        images: await db.select().from(itemImages).where(eq(itemImages.itemId, id)).orderBy(asc(itemImages.sort)),
        channel_map: await db.select().from(channelItemMap).where(eq(channelItemMap.itemId, id)),
      },
    });
  });

  r.post('/', requirePerm('items:write'), async (req, res) => {
    const body = zItem.parse(req.body);
    if (body.item_type !== 'service' && !body.hsn_sac) throw badRequest('HSN code is required for goods');
    const created = await inTx(db, req, async (ctx) => {
      const [row] = await ctx.tx.insert(items).values({ ...toRow(body), createdBy: ctx.user!.id } as typeof items.$inferInsert).returning();
      await audit(ctx, 'item', row!.id, 'create', null, row);
      return row;
    });
    res.status(201).json({ data: created });
  });

  r.patch('/:id', requirePerm('items:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const body = zItem.partial().parse(req.body);
    const updated = await inTx(db, req, async (ctx) => {
      const [before] = await ctx.tx.select().from(items).where(eq(items.id, id)).for('update');
      must(before, 'Item');
      if (body.item_type && (body.item_type === 'service') !== (before!.itemType === 'service')) {
        const [moved] = await rows(ctx.tx, sql`select 1 as x from stock_movements where item_id = ${id} limit 1`);
        if (moved) throw badRequest('This item has stock history, so it cannot switch between goods and service');
      }
      const patch = Object.fromEntries(Object.entries(toRow(body)).filter(([, v]) => v !== undefined));
      const [row] = await ctx.tx.update(items).set({ ...patch, updatedAt: new Date() }).where(eq(items.id, id)).returning();
      await audit(ctx, 'item', id, 'update', before, row);
      return row;
    });
    res.json({ data: updated });
  });

  r.post('/:id/images', requirePerm('items:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const body = z.object({ url: zLink, sort: z.number().int().default(0) }).parse(req.body);
    const [item] = await db.select({ id: items.id }).from(items).where(eq(items.id, id));
    must(item, 'Item');
    const [row] = await db.insert(itemImages).values({ itemId: id, url: body.url, sort: body.sort, createdBy: req.user!.id }).returning();
    res.status(201).json({ data: row });
  });

  r.get('/:id/images', requirePerm('items:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    res.json({ data: await db.select().from(itemImages).where(eq(itemImages.itemId, id)).orderBy(asc(itemImages.sort), asc(itemImages.createdAt)) });
  });

  /** Take a picture off an item. The file itself is kept: another record may point at it. */
  r.delete('/:id/images/:imageId', requirePerm('items:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const imageId = zId.parse(req.params.imageId);
    const gone = await db.delete(itemImages).where(and(eq(itemImages.id, imageId), eq(itemImages.itemId, id))).returning({ id: itemImages.id });
    must(gone[0], 'Picture');
    res.json({ ok: true });
  });

  /** Our SKU <-> Shopify/Amazon/Flipkart product ids (PRD 7.5). */
  r.put('/:id/channel-map', requirePerm('items:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const body = z.object({
      channel: z.enum(CHANNELS), external_product_id: zText(100), external_variant_id: z.string().max(100).default(''),
    }).parse(req.body);
    const [row] = await db.insert(channelItemMap)
      .values({ itemId: id, channel: body.channel, externalProductId: body.external_product_id,
        externalVariantId: body.external_variant_id, createdBy: req.user!.id })
      .onConflictDoUpdate({
        target: [channelItemMap.channel, channelItemMap.externalProductId, channelItemMap.externalVariantId],
        set: { itemId: id, updatedAt: new Date() },
      }).returning();
    res.json({ data: row });
  });
  return r;
}

