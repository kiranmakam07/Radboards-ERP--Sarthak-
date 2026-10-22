import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { D, SELLING_PARTY_TYPES, STATE_CODES, formatINR, istDate, money, normalisePhone, stateCodeFor, type Channel } from '@radcore/shared';
import { getCompany } from '../core/settings';
import { rows, type DB } from '../db/client';
import { channelEvents, items, leads, parties, salesOrderLines, salesOrders } from '../db/schema';
import { parseCsv } from '../lib/bank-csv';
import { badRequest, conflict } from '../lib/errors';
import type { Ctx } from '../lib/http';
import { createParty } from './parties';
import { cancelOrder, confirmOrder, createOrder, orderTotals } from './sales';

/**
 * Orders placed somewhere else (the Shopify store, Amazon, Flipkart) arriving here as confirmed
 * sales orders, so that stores deliver and accounts invoice them exactly like any other order.
 *
 * Whatever the channel, an order is first read into one plain shape (OnlineOrder) and then taken
 * in by takeOrder. Shopify sends each order by webhook; Amazon and Flipkart orders come from the
 * order report downloaded from the seller site. Nothing is taken in twice: the channel's own
 * order number is kept on the sales order.
 */
export const ONLINE_CHANNELS = ['shopify', 'amazon', 'flipkart'] as const;
export type OnlineChannel = (typeof ONLINE_CHANNELS)[number];
export const isOnlineChannel = (c: string): c is OnlineChannel => (ONLINE_CHANNELS as readonly string[]).includes(c);
export const CHANNEL_NAMES: Record<OnlineChannel, string> = { shopify: 'Shopify', amazon: 'Amazon', flipkart: 'Flipkart' };

export type OnlineOrder = {
  channel: OnlineChannel;
  /** The channel's own id for the order: what makes it "the same order" if it arrives again. */
  externalId: string;
  /** The number a person would quote, e.g. "#1042". */
  name: string;
  orderDate: string;
  currency: string;
  customer: { name: string | null; phone: string | null; email: string | null };
  address: { line1: string; line2: string; city: string; state: string; pincode: string };
  lines: { sku: string | null; title: string; qty: string; unitPrice: string; discount: string }[];
  shipping: string;
  taxInclusive: boolean;
  /** What the channel says the customer pays in all, for comparing with what the order comes to here. */
  total: string | null;
  payment: 'paid' | 'pending' | 'unknown';
  paymentNote: string | null;
  note: string | null;
};

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const amount = (v: unknown): string => {
  const cleaned = text(v).replace(/[₹,\s]|INR|Rs\.?/gi, '');
  return cleaned && /^-?\d+(\.\d+)?$/.test(cleaned) ? money(cleaned) : '0.00';
};

// ---------------------------------------------------------------------------
// Shopify (the "orders/create" webhook body, which is the Order object)
// ---------------------------------------------------------------------------
export function fromShopify(p: any): OnlineOrder {
  const ship = p.shipping_address ?? p.billing_address ?? p.customer?.default_address ?? {};
  const customerName = [text(p.customer?.first_name), text(p.customer?.last_name)].filter(Boolean).join(' ') || text(ship.name) || null;
  const gateways = Array.isArray(p.payment_gateway_names) ? p.payment_gateway_names.map(text).filter(Boolean).join(', ') : text(p.gateway);
  const status = text(p.financial_status);
  return {
    channel: 'shopify',
    externalId: text(p.id),
    name: text(p.name) || `#${text(p.order_number) || text(p.id)}`,
    orderDate: p.created_at && !Number.isNaN(Date.parse(p.created_at)) ? istDate(new Date(p.created_at)) : istDate(),
    currency: text(p.currency) || 'INR',
    customer: {
      name: customerName,
      phone: normalisePhone(text(ship.phone) || text(p.customer?.phone) || text(p.phone)),
      email: (text(p.email) || text(p.customer?.email) || text(p.contact_email)).toLowerCase() || null,
    },
    address: {
      line1: text(ship.address1), line2: text(ship.address2), city: text(ship.city),
      state: text(ship.province_code) || text(ship.province), pincode: text(ship.zip),
    },
    lines: (Array.isArray(p.line_items) ? p.line_items : []).map((l: any) => ({
      sku: text(l.sku) || null,
      title: [text(l.title), text(l.variant_title)].filter(Boolean).join(' / ') || 'Item',
      qty: text(l.quantity) || '0',
      unitPrice: amount(l.price),
      // Shopify spreads every discount code over the lines it applies to.
      discount: money((Array.isArray(l.discount_allocations) ? l.discount_allocations : []).reduce((a: ReturnType<typeof D>, d: any) => a.plus(amount(d.amount)), D(0))),
    })),
    shipping: money((Array.isArray(p.shipping_lines) ? p.shipping_lines : []).reduce((a: ReturnType<typeof D>, s: any) => a.plus(amount(s.discounted_price ?? s.price)), D(0))),
    taxInclusive: p.taxes_included !== false,
    total: p.total_price != null ? amount(p.total_price) : null,
    payment: status === 'paid' ? 'paid' : status ? 'pending' : 'unknown',
    paymentNote: status === 'paid' ? `Paid online${gateways ? ` (${gateways})` : ''}` : status === 'pending' ? `Not paid yet${gateways ? ` (${gateways})` : ''}: collect on delivery` : status ? `Payment: ${status.replace(/_/g, ' ')}` : null,
    note: text(p.note) || null,
  };
}

// ---------------------------------------------------------------------------
// Amazon and Flipkart (the order report downloaded from the seller site)
// ---------------------------------------------------------------------------
const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
/** The names each column goes by in the reports we know of. First match wins. */
const COLUMNS: Record<string, string[]> = {
  orderId: ['amazonorderid', 'orderid', 'orderitemid', 'orderno', 'ordernumber'],
  date: ['purchasedate', 'orderdate', 'orderedon', 'orderapprovaldate', 'date'],
  sku: ['sku', 'sellersku', 'merchantsku', 'skuid', 'skucode'],
  title: ['productname', 'product', 'producttitle', 'title', 'itemname', 'itemdescription'],
  qty: ['quantitypurchased', 'quantity', 'qty'],
  unitPrice: ['sellingpriceperitem', 'unitprice', 'priceperunit', 'sellingprice'],
  lineAmount: ['itemprice', 'invoiceamount', 'orderitemvalue', 'itemtotal', 'totalprice', 'amount', 'total'],
  shipping: ['shippingprice', 'shippingcharge', 'shippingcharges', 'shipping', 'shippingandhandlingcharges'],
  status: ['orderstatus', 'orderitemstatus', 'itemstatus', 'status'],
  buyer: ['recipientname', 'buyername', 'customername', 'shiptoname', 'shippingname'],
  state: ['shipstate', 'shippingstate', 'state', 'deliverystate'],
  city: ['shipcity', 'shippingcity', 'city'],
  pincode: ['shippostalcode', 'pincode', 'pin', 'postalcode', 'shippingpincode'],
  address: ['shipaddress1', 'shippingaddress', 'address', 'addressline1'],
};

/** A date as these reports write it: 2026-10-11T08:12:33+05:30, 11-10-2026, 11/10/2026 or "Oct 11, 2026". */
function reportDate(raw: string): string | null {
  const v = raw.trim();
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(v);
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const at = Date.parse(v);
  // A report with a time carries its time zone; one with only a day means that day in India.
  return Number.isNaN(at) ? null : /\d:\d\d/.test(v) ? istDate(new Date(at)) : new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export class OrderFileError extends Error {}

/**
 * Read an order report into orders. One row is one item of an order; rows that share an order
 * number become one order. Cancelled rows are left out.
 */
export function parseOrderFile(channel: 'amazon' | 'flipkart', file: string): { orders: OnlineOrder[]; skipped: number } {
  // Amazon's reports are tab-separated, Flipkart's comma-separated.
  const firstLine = file.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  const table = firstLine.split('\t').length > firstLine.split(',').length
    ? file.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split('\t').map((c) => c.trim()))
    : parseCsv(file);
  const header = (table[0] ?? []).map(key);
  const at: Record<string, number> = {};
  for (const [field, names] of Object.entries(COLUMNS)) {
    const found = names.map((n) => header.indexOf(n)).find((i) => i >= 0);
    if (found !== undefined) at[field] = found;
  }
  const missing = [
    at.orderId === undefined ? 'the order number' : null, at.sku === undefined ? 'the SKU' : null, at.qty === undefined ? 'the quantity' : null,
    at.unitPrice === undefined && at.lineAmount === undefined ? 'the price' : null,
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new OrderFileError(`This does not look like a ${CHANNEL_NAMES[channel]} order report: no column for ${missing.join(', ')}. Columns found: ${(table[0] ?? []).slice(0, 12).join(', ') || 'none'}.`);
  }
  const cell = (r: string[], field: string) => (at[field] === undefined ? '' : (r[at[field]!] ?? '').trim());

  const byOrder = new Map<string, OnlineOrder>();
  let skipped = 0;
  for (const [n, r] of table.slice(1).entries()) {
    const id = cell(r, 'orderId');
    if (!id) continue;
    if (/cancel|return/i.test(cell(r, 'status'))) {
      skipped++;
      continue;
    }
    const qty = cell(r, 'qty');
    if (!/^\d+(\.\d+)?$/.test(qty) || Number(qty) <= 0) throw new OrderFileError(`Row ${n + 2}: the quantity "${qty}" is not a number above zero.`);
    const date = reportDate(cell(r, 'date')) ?? (at.date === undefined ? istDate() : null);
    if (!date) throw new OrderFileError(`Row ${n + 2}: the date "${cell(r, 'date')}" could not be read.`);
    // Some reports give the price of one, others what the customer pays for the whole row.
    const unitPrice = at.unitPrice !== undefined && amount(cell(r, 'unitPrice')) !== '0.00'
      ? amount(cell(r, 'unitPrice')) : money(D(amount(cell(r, 'lineAmount'))).div(qty));
    const order = byOrder.get(id) ?? {
      channel, externalId: id, name: id, orderDate: date, currency: 'INR',
      customer: { name: cell(r, 'buyer') || null, phone: null, email: null },
      address: { line1: cell(r, 'address'), line2: '', city: cell(r, 'city'), state: cell(r, 'state'), pincode: cell(r, 'pincode') },
      lines: [], shipping: '0.00', taxInclusive: true, total: null, payment: 'unknown' as const,
      paymentNote: `Paid to ${CHANNEL_NAMES[channel]}, which settles with us`, note: null,
    };
    order.lines.push({ sku: cell(r, 'sku') || null, title: cell(r, 'title') || cell(r, 'sku') || 'Item', qty, unitPrice, discount: '0.00' });
    order.shipping = money(D(order.shipping).plus(amount(cell(r, 'shipping'))));
    byOrder.set(id, order);
  }
  return { orders: [...byOrder.values()], skipped };
}

// ---------------------------------------------------------------------------
// Taking an order in
// ---------------------------------------------------------------------------
const SHIPPING_SKU = 'SHIPPING';

/** Shipping charged to the customer is a line of its own; the item for it is made the first time it is needed. */
async function shippingItem(ctx: Ctx): Promise<string> {
  const [found] = await ctx.tx.select({ id: items.id }).from(items).where(eq(items.sku, SHIPPING_SKU));
  if (found) return found.id;
  const [made] = await ctx.tx.insert(items).values({
    sku: SHIPPING_SKU, name: 'Shipping & handling', itemType: 'service', hsnSac: '996812', gstRate: '18', isStockItem: false,
    createdBy: ctx.user?.id ?? null,
  }).returning({ id: items.id });
  return made!.id;
}

/**
 * Who the order is billed to. A Shopify order is our own customer: matched on phone, then email,
 * otherwise added. A marketplace collects the money itself and pays us in settlements, so its
 * orders all sit under the marketplace's name and the buyer is kept in the order's notes.
 */
async function partyFor(ctx: Ctx, o: OnlineOrder, stateCode: string): Promise<string> {
  const { tx } = ctx;
  if (o.channel !== 'shopify') {
    const name = `${CHANNEL_NAMES[o.channel]} marketplace`;
    const [found] = await tx.select({ id: parties.id }).from(parties).where(and(eq(parties.name, name), eq(parties.partyType, 'customer'))).limit(1);
    return found?.id ?? (await createParty(ctx, { party_type: 'customer', name })).id;
  }
  const { phone, email } = o.customer;
  if (phone) {
    // One at a time per phone, so two orders from the same new customer cannot both add them.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`party:${phone}`}, 0))`);
    const [found] = await tx.select({ id: parties.id }).from(parties)
      .where(and(eq(parties.phone, phone), inArray(parties.partyType, [...SELLING_PARTY_TYPES]))).orderBy(asc(parties.createdAt)).limit(1);
    if (found) return found.id;
  } else if (email) {
    const [found] = await tx.select({ id: parties.id }).from(parties)
      .where(and(sql`lower(${parties.email}) = ${email}`, inArray(parties.partyType, [...SELLING_PARTY_TYPES]))).orderBy(asc(parties.createdAt)).limit(1);
    if (found) return found.id;
  }
  // If this phone enquired before, the sale is credited to where that enquiry came from.
  const [lead] = phone ? await tx.select({ id: leads.id }).from(leads).where(eq(leads.phone, phone)).orderBy(asc(leads.createdAt)).limit(1) : [];
  const address = { ...o.address, state: STATE_CODES[stateCode] ?? o.address.state };
  const party = await createParty(ctx, {
    party_type: 'customer', name: (o.customer.name ?? `Shopify customer ${o.name}`).slice(0, 200), phone, email, state_code: stateCode,
    billing_address: address, shipping_address: address, lead_id: lead?.id ?? null,
  });
  return party.id;
}

/** Turn one online order into a confirmed sales order. Safe to call again for the same order. */
export async function takeOrder(ctx: Ctx, o: OnlineOrder): Promise<{ orderId: string; summary: string; created: boolean }> {
  const { tx } = ctx;
  const label = `${CHANNEL_NAMES[o.channel]} ${o.name}`;
  if (!o.externalId) throw badRequest('The order has no number');
  // One at a time per order, so the same order arriving twice at once is taken in once.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${o.channel}:${o.externalId}`}, 0))`);
  const [already] = await tx.select().from(salesOrders).where(and(eq(salesOrders.channel, o.channel as Channel), eq(salesOrders.externalOrderId, o.externalId)));
  if (already) return { orderId: already.id, summary: `${label} · already here as ${already.orderNo}`, created: false };

  if (o.currency !== 'INR') throw badRequest(`${label} is in ${o.currency}. Only orders in rupees are taken in.`);
  if (o.lines.length === 0) throw badRequest(`${label} has no items`);
  const noSku = o.lines.filter((l) => !l.sku);
  if (noSku.length > 0) throw badRequest(`${label}: "${noSku[0]!.title}" has no SKU on ${CHANNEL_NAMES[o.channel]}. Give it the same SKU as the item here, then try again.`);
  const skus = [...new Set(o.lines.map((l) => l.sku!.toLowerCase()))];
  const found = await tx.select({ id: items.id, sku: items.sku }).from(items).where(inArray(sql`lower(${items.sku})`, skus));
  const bySku = new Map(found.map((i) => [i.sku.toLowerCase(), i.id]));
  const unknown = o.lines.filter((l) => !bySku.has(l.sku!.toLowerCase()));
  if (unknown.length > 0) {
    const list = [...new Set(unknown.map((l) => `${l.sku} (${l.title})`))].join(', ');
    throw badRequest(`${label}: no item here has the SKU ${list}. Add the item or correct its SKU, then try again.`);
  }

  const company = await getCompany(tx);
  const stateCode = stateCodeFor(o.address.state) ?? company.state_code;
  const partyId = await partyFor(ctx, o, stateCode);
  const lines = o.lines.map((l) => ({ itemId: bySku.get(l.sku!.toLowerCase())!, qty: l.qty, rate: l.unitPrice, discount: l.discount }));
  if (D(o.shipping).gt(0)) lines.push({ itemId: await shippingItem(ctx), qty: '1', rate: o.shipping, discount: '0.00' });

  const buyer = o.channel === 'shopify' ? null
    : [o.customer.name, [o.address.city, o.address.state, o.address.pincode].filter(Boolean).join(', ')].filter(Boolean).join(', ');
  const order = await createOrder(ctx, {
    channel: o.channel, partyId, externalOrderId: o.externalId, orderDate: o.orderDate, placeOfSupply: stateCode, taxInclusive: o.taxInclusive,
    notes: [label, o.paymentNote, buyer ? `Ship to: ${buyer}` : null, o.note ? `Customer's note: ${o.note}` : null].filter(Boolean).join('. ').slice(0, 2000),
    lines,
  });
  // The customer has already ordered and (usually) paid: there is no credit decision left to make here.
  // Paid on the channel, at the channel's own price: neither the credit nor the price check applies.
  await confirmOrder(ctx, order.id, { skipCreditCheck: true, skipPriceCheck: true });

  const made = await tx.select().from(salesOrderLines).where(eq(salesOrderLines.orderId, order.id));
  const { totals } = await orderTotals(tx, order, made);
  const differs = o.total !== null && !D(o.total).eq(totals.grandTotal);
  return {
    orderId: order.id, created: true,
    summary: `${label} · ${o.customer.name ?? 'no name'} · ₹${formatINR(totals.grandTotal)} · ${order.orderNo}`
      + (differs ? ` · ${CHANNEL_NAMES[o.channel]} says ₹${formatINR(o.total!)}: check the prices and GST rates` : ''),
  };
}

/** The customer cancelled on the channel. Before delivery the order here is cancelled too; after it, a person decides. */
export async function cancelOnlineOrder(ctx: Ctx, channel: OnlineChannel, externalId: string, name: string): Promise<{ orderId: string | null; summary: string }> {
  const { tx } = ctx;
  const label = `${CHANNEL_NAMES[channel]} ${name}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${channel}:${externalId}`}, 0))`);
  const [order] = await tx.select().from(salesOrders).where(and(eq(salesOrders.channel, channel as Channel), eq(salesOrders.externalOrderId, externalId)));
  if (!order) {
    // It never got in (an unknown SKU, say). Stop it asking for attention: there is nothing left to take in.
    await tx.update(channelEvents).set({ status: 'ignored', error: 'Cancelled by the customer before it was taken in' })
      .where(and(eq(channelEvents.channel, channel), eq(channelEvents.eventType, 'order'), eq(channelEvents.externalId, externalId), inArray(channelEvents.status, ['received', 'failed'])));
    return { orderId: null, summary: `${label} · cancelled before it was taken in` };
  }
  if (order.status === 'cancelled') return { orderId: order.id, summary: `${label} · ${order.orderNo} was already cancelled` };
  if (order.status === 'delivered' || order.status === 'invoiced') {
    throw conflict(`${label} was cancelled by the customer, but ${order.orderNo} has already been ${order.status} here. Take the goods back with a credit note, then ignore this.`);
  }
  await cancelOrder(ctx, order.id, `Cancelled on ${CHANNEL_NAMES[channel]}`);
  return { orderId: order.id, summary: `${label} · cancelled, so ${order.orderNo} is cancelled too` };
}

/** How many online orders are waiting at each step, for the Online orders screen. */
export async function onlineSummary(db: DB) {
  return rows(db, sql`
    select o.channel, count(*)::int as orders,
           count(*) filter (where o.status = 'confirmed')::int as to_deliver,
           count(*) filter (where o.status = 'delivered')::int as to_invoice,
           max(o.created_at) as last_order_at
      from sales_orders o where o.channel in ('shopify', 'amazon', 'flipkart') and o.created_at > now() - interval '30 days'
     group by o.channel`);
}
