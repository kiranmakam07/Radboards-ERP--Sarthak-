import { sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import {
  D, GST_RATES, ITEM_TYPES, PARTY_STATE_CODES, isValidGstin, money, normaliseGstin, normalisePhone, qty as fmtQty, stateCodeFor,
  type Decimal,
} from '@radcore/shared';
import { audit } from '../core/audit';
import { requirePerm } from '../core/auth';
import { postJournal, type JLine } from '../core/journal';
import { locationByType } from '../core/stock';
import { rows, type DB } from '../db/client';
import { items } from '../db/schema';
import { parseCsv } from '../lib/bank-csv';
import { badRequest, conflict } from '../lib/errors';
import { inTx, zDate, zId, type Ctx } from '../lib/http';
import { createAdjustment, decideAdjustment } from './inventory';
import { createParty } from './parties';

/**
 * Moving from Vyapar: Vyapar's closing balances become RadCore's opening balances, and the business carries on
 * from there (Sarthak, 26 Oct 2026: "We can put the opening and closing balances and continue from there"; the
 * technical review of the same day found no way to bring anything in, and no report to compare the two during
 * the month they run side by side).
 *
 * Three steps bring the balances in, each from a CSV file (Vyapar's own export saved as CSV, or the template),
 * each checked first (every row and every problem listed, nothing saved) and then imported all or nothing:
 *   parties    customers, dealers and suppliers, each with the balance it closed at
 *   items      products, with the stock and its value at the close
 *   accounts   the other closing balances: cash, each bank account, loans, capital, GST credit carried forward
 * and a fourth compares Vyapar's closing figures with RadCore's on a date: parties, stock or accounts.
 *
 * Postings, all against Opening Balance Equity (3200) on the cut-over date:
 *   a party that owes us        Dr Debtors (the party)   / Cr Opening Balance Equity
 *   a party we owe              Dr Opening Balance Equity / Cr Creditors, for a supplier (Debtors for a customer's advance)
 *   stock                       an opening stock entry (Dr Stock / Cr Opening Balance Equity), on the day it is imported
 *   other accounts              one entry, each account at its balance, the difference to Opening Balance Equity
 * Once all three are in, Opening Balance Equity holds the business's worth as Vyapar had it. Old bills are not
 * brought in one by one: a party's balance is one figure, and a payment against it is taken on account.
 */

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------
/** A column's name as written in the file, reduced to letters and digits, so "Phone No." and "phone_no" are one. */
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The names each field may have in the file: the template's first, then Vyapar's and other common ones. */
const COLUMNS = {
  parties: {
    name: ['name', 'partyname', 'party', 'customername', 'suppliername'],
    type: ['type', 'partytype', 'group', 'partygroup', 'category'],
    phone: ['phone', 'phoneno', 'mobile', 'mobileno', 'contactno', 'contact', 'phonenumber'],
    email: ['email', 'emailid'],
    gstin: ['gstin', 'gstno', 'gstinno', 'gst', 'gstnumber'],
    state: ['state', 'stateofsupply', 'placeofsupply'],
    address: ['address', 'billingaddress'],
    city: ['city'],
    pincode: ['pincode', 'pin', 'zip'],
    credit_limit: ['creditlimit'],
    payment_terms_days: ['paymenttermsdays', 'paymentterms', 'creditdays', 'creditperiod'],
    balance: ['balance', 'openingbalance', 'closingbalance', 'currentbalance'],
    receivable: ['receivable', 'receivablebalance', 'toreceive', 'youwillget'],
    payable: ['payable', 'payablebalance', 'topay', 'youwillgive'],
  },
  items: {
    sku: ['sku', 'itemcode', 'code'],
    name: ['name', 'itemname', 'item', 'product', 'productname'],
    type: ['type', 'itemtype', 'kind'],
    hsn: ['hsn', 'hsncode', 'hsnsac', 'sac', 'hsnsaccode'],
    gst_rate: ['gstrate', 'gst', 'taxrate', 'tax', 'gstpercent'],
    unit: ['unit', 'baseunit', 'uom'],
    retail_price: ['retailprice', 'saleprice', 'salesprice', 'sellingprice'],
    dealer_price: ['dealerprice', 'wholesaleprice'],
    mrp: ['mrp'],
    purchase_cost: ['purchasecost', 'purchaseprice', 'costprice', 'cost'],
    qty: ['qty', 'stock', 'stockqty', 'stockquantity', 'openingstock', 'openingqty', 'closingstock', 'closingqty', 'quantity', 'currentstock'],
    value: ['value', 'stockvalue', 'closingvalue', 'openingvalue'],
    rate: ['rate', 'stockrate', 'atprice', 'costrate'],
    serials: ['serials', 'serialnos', 'serialnumbers', 'chassisnos', 'imei'],
  },
  accounts: {
    code: ['code', 'accountcode'],
    account: ['account', 'accountname', 'name', 'ledger', 'ledgername'],
    debit: ['debit', 'dr', 'debitbalance'],
    credit: ['credit', 'cr', 'creditbalance'],
    balance: ['balance', 'closingbalance', 'openingbalance'],
  },
} as const;
type Kind = keyof typeof COLUMNS;
type Fields<K extends Kind> = keyof (typeof COLUMNS)[K];

/** The templates: the header, and one example line that shows how each field is written. */
const TEMPLATES: Record<Kind, string> = {
  parties: 'name,type,phone,email,gstin,state,address,city,pincode,credit_limit,payment_terms_days,receivable,payable\r\n'
    + 'Pune Boards,dealer,9822000001,,27ABCDE1234F1Z5,Maharashtra,Shop 4 FC Road,Pune,411004,200000,30,45000,\r\n',
  items: 'sku,name,type,hsn,gst_rate,unit,retail_price,dealer_price,mrp,purchase_cost,qty,value,serials\r\n'
    + 'BRD-01,Cruiser Board,finished_good,950699,18,Nos,5900,4000,6500,2500,20,50000,\r\n',
  accounts: 'code,account,debit,credit\r\n1100,Cash in Hand,25000,\r\n',
};

type Row<K extends Kind> = { row: number; values: Partial<Record<Fields<K>, string>> };

function readFile<K extends Kind>(kind: K, csv: string): Row<K>[] {
  const lines = parseCsv(csv).filter((r) => r.some((c) => c.trim() !== ''));
  if (lines.length < 2) throw badRequest('The file has no rows under its heading line');
  const head = lines[0]!.map(key);
  const at = {} as Record<Fields<K>, number>;
  for (const [field, names] of Object.entries(COLUMNS[kind]) as [Fields<K>, readonly string[]][]) {
    const i = head.findIndex((h) => names.includes(h));
    if (i >= 0) at[field] = i;
  }
  return lines.slice(1).map((cells, n) => {
    const values: Partial<Record<Fields<K>, string>> = {};
    for (const [field, i] of Object.entries(at) as [Fields<K>, number][]) values[field] = (cells[i] ?? '').trim();
    return { row: n + 2, values };
  });
}

/** An amount as files write it: "1,23,456.50", "₹ 500", "(250.00)", "250 Cr", "-250". Null when blank; 'bad' when not a number. */
function amount(text: string | undefined): Decimal | null | 'bad' {
  let t = (text ?? '').replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
  if (t === '' || t === '-') return null;
  let sign = 1;
  if (/^\(.*\)$/.test(t)) { sign = -1; t = t.slice(1, -1); }
  if (/cr$/i.test(t)) { sign = -sign; t = t.slice(0, -2); } else if (/dr$/i.test(t)) t = t.slice(0, -2);
  if (!/^-?\d+(\.\d+)?$/.test(t)) return 'bad';
  return D(t).times(sign);
}

type Checked<T> = { row: number; data: T; problems: string[] };
const result = <T>(checked: Checked<T>[]) => ({
  rows: checked.map((c) => ({ row: c.row, ...c.data, problems: c.problems })),
  problems: checked.reduce((n, c) => n + c.problems.length, 0),
});

// ---------------------------------------------------------------------------
// 1. Parties and their balances
// ---------------------------------------------------------------------------
type PartyRow = {
  name: string; party_type: 'customer' | 'dealer' | 'supplier' | 'franchisee'; phone: string | null; email: string | null; gstin: string | null;
  state_code: string | null; address: string; city: string; pincode: string; credit_limit: string | null; payment_terms_days: number | null;
  /** + they owe us, - we owe them. */
  balance: string;
};

const partyType = (t: string): PartyRow['party_type'] => {
  const w = t.toLowerCase();
  if (/suppl|vendor|creditor/.test(w)) return 'supplier';
  if (/franch/.test(w)) return 'franchisee';
  if (/dealer|distribut|retailer|wholesal/.test(w)) return 'dealer';
  return 'customer';
};

async function checkParties(tx: DB, csv: string): Promise<Checked<PartyRow>[]> {
  const seen = new Set<string>();
  const out: Checked<PartyRow>[] = [];
  for (const { row, values: v } of readFile('parties', csv)) {
    const problems: string[] = [];
    const name = (v.name ?? '').slice(0, 200);
    if (!name) problems.push('No name');
    const phone = v.phone ? normalisePhone(v.phone) : null;
    if (v.phone && !phone) problems.push(`Phone "${v.phone}" is not a phone number`);
    const gstin = v.gstin ? normaliseGstin(v.gstin) : null;
    if (gstin && !isValidGstin(gstin)) problems.push(`GSTIN "${v.gstin}" is not a valid GSTIN`);
    const email = v.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email) ? v.email.toLowerCase() : null;
    if (v.email && !email) problems.push(`Email "${v.email}" is not an email address`);
    let stateCode = gstin && isValidGstin(gstin) ? gstin.slice(0, 2) : null;
    if (!stateCode && v.state) {
      stateCode = /outside|abroad|foreign|other\s*count/i.test(v.state) ? '96' : stateCodeFor(v.state);
      if (!stateCode) problems.push(`State "${v.state}" is not a state of India`);
    }
    if (stateCode && !PARTY_STATE_CODES[stateCode]) problems.push(`State code ${stateCode} is not known`);
    const nums: Record<string, Decimal | null> = {};
    for (const f of ['balance', 'receivable', 'payable', 'credit_limit'] as const) {
      const a = amount(v[f]);
      if (a === 'bad') problems.push(`${f.replace('_', ' ')} "${v[f]}" is not an amount`);
      nums[f] = a === 'bad' ? null : a;
    }
    const balance = nums.receivable !== null || nums.payable !== null
      ? (nums.receivable ?? D(0)).abs().minus((nums.payable ?? D(0)).abs())
      : (nums.balance ?? D(0));
    const terms = v.payment_terms_days ? Number(v.payment_terms_days.replace(/[^0-9]/g, '')) : null;
    if (terms !== null && (!Number.isInteger(terms) || terms > 365)) problems.push(`Payment terms "${v.payment_terms_days}" are not 0 to 365 days`);
    const type = partyType(v.type ?? '');
    // Already here, or twice in the file.
    const id = gstin ? `g:${gstin}` : phone ? `p:${type}:${phone}` : `n:${type}:${name.toLowerCase()}`;
    if (seen.has(id)) problems.push('Appears twice in the file');
    seen.add(id);
    const [existing] = await rows<{ name: string }>(tx, sql`
      select name from parties
       where (${gstin}::text is not null and gstin = ${gstin}) or (${phone}::text is not null and phone = ${phone} and party_type::text = ${type})
          or (lower(name) = lower(${name}) and party_type::text = ${type}) limit 1`);
    if (existing) problems.push(`Already in RadCore as ${existing.name}`);
    out.push({
      row, problems,
      data: {
        name, party_type: type, phone, email, gstin, state_code: stateCode, address: (v.address ?? '').slice(0, 200), city: (v.city ?? '').slice(0, 100),
        pincode: (v.pincode ?? '').slice(0, 10), credit_limit: nums.credit_limit ? money(nums.credit_limit.abs()) : null, payment_terms_days: terms,
        balance: money(balance),
      },
    });
  }
  return out;
}

/** Make the parties and post each one's closing balance against Opening Balance Equity on the cut-over date. */
async function importParties(ctx: Ctx, checked: Checked<PartyRow>[], asOf: string) {
  let receivable = D(0);
  let payable = D(0);
  for (const { data: p } of checked) {
    const party = await createParty(ctx, {
      party_type: p.party_type, name: p.name, phone: p.phone, email: p.email, gstin: p.gstin, state_code: p.state_code,
      billing_address: { line1: p.address, line2: '', city: p.city, state: p.state_code ? (PARTY_STATE_CODES[p.state_code] ?? '') : '', pincode: p.pincode },
      credit_limit: p.credit_limit, payment_terms_days: p.payment_terms_days,
    });
    const bal = D(p.balance);
    if (bal.isZero()) continue;
    // A supplier's balance sits in Creditors, a customer's or dealer's in Debtors, whichever way round it is.
    const control = p.party_type === 'supplier' ? 'creditors' : 'debtors';
    const lines: JLine[] = bal.gt(0)
      ? [{ account: control, partyId: party.id, debit: bal }, { account: 'opening_equity', credit: bal }]
      : [{ account: 'opening_equity', debit: bal.neg() }, { account: control, partyId: party.id, credit: bal.neg() }];
    await postJournal(ctx, { date: asOf, refType: 'opening_balance', refId: party.id, narration: `Opening balance from Vyapar: ${p.name}`, lines });
    if (bal.gt(0)) receivable = receivable.plus(bal);
    else payable = payable.plus(bal.neg());
  }
  return { parties: checked.length, receivable: money(receivable), payable: money(payable) };
}

// ---------------------------------------------------------------------------
// 2. Items and their stock
// ---------------------------------------------------------------------------
type ItemRow = {
  sku: string; name: string; item_type: (typeof ITEM_TYPES)[number]; hsn: string | null; gst_rate: string; unit: string;
  retail_price: string; dealer_price: string; mrp: string; purchase_cost: string; qty: string; unit_cost: string; serials: string[] | null;
};

const itemType = (t: string): ItemRow['item_type'] => {
  const w = key(t);
  const exact = ITEM_TYPES.find((x) => key(x) === w);
  if (exact) return exact;
  if (/service|labour|labor/.test(w)) return 'service';
  if (/vehicle|scooter|bike|cycle/.test(w)) return 'vehicle';
  if (/spare|part/.test(w)) return 'spare_part';
  if (/raw|material/.test(w)) return 'raw_material';
  if (/accessor/.test(w)) return 'accessory';
  if (/consumab/.test(w)) return 'consumable';
  return 'finished_good';
};

async function checkItems(tx: DB, csv: string): Promise<Checked<ItemRow>[]> {
  const seen = new Set<string>();
  const out: Checked<ItemRow>[] = [];
  let made = 0;
  for (const { row, values: v } of readFile('items', csv)) {
    const problems: string[] = [];
    const name = (v.name ?? '').slice(0, 200);
    if (!name) problems.push('No name');
    // An item with no code gets one; the codes can be changed later on the product's page.
    const sku = (v.sku || `VY-${String(++made).padStart(4, '0')}`).toUpperCase().slice(0, 60);
    const type = itemType(v.type ?? '');
    const hsn = (v.hsn ?? '').replace(/\s/g, '') || null;
    if (type !== 'service' && !hsn) problems.push('HSN code is needed for goods');
    if (hsn && !/^\d{4,8}$/.test(hsn)) problems.push(`HSN "${hsn}" is not 4 to 8 digits`);
    const rateText = (v.gst_rate ?? '').match(/\d+(\.\d+)?/)?.[0] ?? '';
    const gst = rateText === '' ? 18 : Number(rateText);
    if (!(GST_RATES as readonly number[]).includes(gst)) problems.push(`GST rate "${v.gst_rate}" is not one of ${GST_RATES.join(', ')}`);
    const num = (f: 'retail_price' | 'dealer_price' | 'mrp' | 'purchase_cost' | 'qty' | 'value' | 'rate') => {
      const a = amount(v[f]);
      if (a === 'bad' || (a && a.lt(0))) { problems.push(`${f.replace('_', ' ')} "${v[f]}" is not a number of 0 or more`); return D(0); }
      return a ?? D(0);
    };
    const prices = { retail: num('retail_price'), dealer: num('dealer_price'), mrp: num('mrp'), cost: num('purchase_cost') };
    const q = num('qty');
    const value = num('value');
    const rate = num('rate');
    if (type === 'service' && q.gt(0)) problems.push('A service has no stock');
    if (!q.isInteger() && type === 'vehicle') problems.push('Vehicles are counted in whole numbers');
    // What one unit of the opening stock cost: the value over the quantity, or the rate, or the purchase price.
    const unitCost = q.gt(0) ? (value.gt(0) ? value.div(q) : rate.gt(0) ? rate : prices.cost) : D(0);
    if (q.gt(0) && unitCost.isZero()) problems.push('Stock with no value: give its value, rate or purchase price');
    // A vehicle is kept by serial number: its opening stock comes with one serial per unit.
    const serials = v.serials ? v.serials.split(/[;|\n]/).map((s) => s.trim().toUpperCase()).filter(Boolean) : null;
    if (type === 'vehicle' && q.gt(0) && (!serials || serials.length !== q.toNumber())) {
      problems.push(`A vehicle is kept by serial: give its ${q.toNumber()} serial number(s), separated by ;`);
    }
    if (seen.has(sku)) problems.push(`Code ${sku} appears twice in the file`);
    seen.add(sku);
    const [existing] = await rows<{ name: string }>(tx, sql`select name from items where sku = ${sku} limit 1`);
    if (existing) problems.push(`Code ${sku} is already used by ${existing.name}`);
    out.push({
      row, problems,
      data: {
        sku, name, item_type: type, hsn, gst_rate: String(gst), unit: (v.unit || 'Nos').slice(0, 20), retail_price: money(prices.retail),
        dealer_price: money(prices.dealer), mrp: money(prices.mrp), purchase_cost: money(prices.cost.isZero() ? unitCost : prices.cost),
        qty: fmtQty(q), unit_cost: money(unitCost.toDecimalPlaces(2)), serials: type === 'vehicle' ? serials : null,
      },
    });
  }
  return out;
}

/** Make the items, and their stock as one opening stock entry at the place given, approved at once. */
async function importItems(ctx: Ctx, checked: Checked<ItemRow>[], locationId: string) {
  const made: { id: string; row: ItemRow }[] = [];
  for (const { data: i } of checked) {
    const [row] = await ctx.tx.insert(items).values({
      sku: i.sku, name: i.name, itemType: i.item_type, hsnSac: i.hsn, gstRate: i.gst_rate, unit: i.unit, retailPrice: i.retail_price,
      dealerPrice: i.dealer_price, mrp: i.mrp, purchaseCost: i.purchase_cost, isStockItem: i.item_type !== 'service',
      isSerialised: i.item_type === 'vehicle', createdBy: ctx.user?.id ?? null,
    }).returning();
    await audit(ctx, 'item', row!.id, 'create', null, row);
    made.push({ id: row!.id, row: i });
  }
  const stocked = made.filter((m) => D(m.row.qty).gt(0));
  let value = D(0);
  if (stocked.length) {
    const adj = await createAdjustment(ctx, {
      kind: 'opening', locationId, reason: 'Opening stock from Vyapar',
      lines: stocked.map((m) => ({ itemId: m.id, qtyChange: m.row.qty, unitCost: m.row.unit_cost, serials: m.row.serials })),
    });
    await decideAdjustment(ctx, adj.id, true, 'Brought in from Vyapar');
    value = stocked.reduce((s, m) => s.plus(D(m.row.qty).times(m.row.unit_cost)), D(0));
  }
  return { items: made.length, with_stock: stocked.length, stock_value: money(value) };
}

// ---------------------------------------------------------------------------
// 3. Other account balances
// ---------------------------------------------------------------------------
type AccountRow = { account_id: string | null; code: string; account: string; debit: string; credit: string };
/** Brought in by the other steps, or never carried: a party's balance, stock, and the balancing figure itself. */
const NOT_HERE: Record<string, string> = {
  debtors: 'Customers\' balances come in with the parties (step 1)', creditors: 'Suppliers\' balances come in with the parties (step 1)',
  stock: 'Stock comes in with the items (step 2)', opening_equity: 'This is where the difference goes by itself', grni: 'Goods received not billed starts at nothing',
};

async function checkAccounts(tx: DB, csv: string): Promise<Checked<AccountRow>[]> {
  const chart = await rows<{ id: string; code: string; name: string; type: string; is_group: boolean; system_key: string | null }>(tx, sql`
    select id, code, name, type::text, is_group, system_key from accounts where active`);
  const seen = new Set<string>();
  const out: Checked<AccountRow>[] = [];
  for (const { row, values: v } of readFile('accounts', csv)) {
    const problems: string[] = [];
    const acc = chart.find((a) => (v.code && a.code === v.code.trim()) || (v.account && key(a.name) === key(v.account)));
    if (!acc) problems.push(`No account ${v.code || v.account || ''} in the chart of accounts: add it there first (Accounts, Chart of accounts)`);
    else if (acc.is_group) problems.push(`${acc.name} is a heading; give the balance of the account under it`);
    else if (acc.system_key && NOT_HERE[acc.system_key]) problems.push(`${acc.name}: ${NOT_HERE[acc.system_key]}`);
    else if (acc.type === 'income' || acc.type === 'expense') problems.push(`${acc.name} is ${acc.type}: bring the year's profit so far as one figure under Retained Earnings`);
    let debit = D(0);
    let credit = D(0);
    const dr = amount(v.debit);
    const cr = amount(v.credit);
    const bal = amount(v.balance);
    if (dr === 'bad' || cr === 'bad' || bal === 'bad') problems.push('An amount is not a number');
    else if (dr !== null || cr !== null) {
      debit = (dr ?? D(0)).abs();
      credit = (cr ?? D(0)).abs();
    } else if (bal !== null) {
      if (bal.gt(0)) debit = bal; else credit = bal.neg();
    }
    if (debit.isZero() && credit.isZero()) problems.push('No balance');
    if (acc) {
      if (seen.has(acc.id)) problems.push(`${acc.name} appears twice in the file`);
      seen.add(acc.id);
    }
    out.push({ row, problems, data: { account_id: acc?.id ?? null, code: acc?.code ?? v.code ?? '', account: acc?.name ?? v.account ?? '', debit: money(debit), credit: money(credit) } });
  }
  return out;
}

async function importAccounts(ctx: Ctx, checked: Checked<AccountRow>[], asOf: string) {
  const [done] = await rows<{ entry_no: number }>(ctx.tx, sql`
    select e.entry_no::int from journal_entries e where e.ref_type = 'opening_accounts' and e.reverses_entry_id is null
       and not exists (select 1 from journal_entries r where r.reverses_entry_id = e.id) limit 1`);
  if (done) throw conflict(`The opening account balances are already in (journal entry ${done.entry_no}). Reverse that entry first to bring them in again.`);
  const lines: JLine[] = checked.map(({ data: a }) => ({ account: { id: a.account_id! }, debit: a.debit, credit: a.credit }));
  const net = checked.reduce((s, { data: a }) => s.plus(a.debit).minus(a.credit), D(0));
  // The difference is what the business is worth on these figures: it goes to Opening Balance Equity.
  lines.push({ account: 'opening_equity', debit: net.lt(0) ? net.neg() : 0, credit: net.gt(0) ? net : 0 });
  await postJournal(ctx, { date: asOf, refType: 'opening_accounts', refId: null, narration: 'Opening balances from Vyapar', lines });
  return { accounts: checked.length, to_opening_equity: money(net) };
}

// ---------------------------------------------------------------------------
// 4. Comparing with Vyapar
// ---------------------------------------------------------------------------
type Compared = { row: number | null; name: string; vyapar: string | null; radcore: string; difference: string; found: boolean };

async function compare(tx: DB, kind: Kind, csv: string, asOf: string) {
  const out: Compared[] = [];
  const line = (row: number | null, name: string, vyapar: Decimal | null, radcore: Decimal, found: boolean) =>
    out.push({ row, name, vyapar: vyapar === null ? null : money(vyapar), radcore: money(radcore), difference: money(radcore.minus(vyapar ?? 0)), found });

  if (kind === 'parties') {
    const balances = await rows<{ id: string; name: string; phone: string | null; gstin: string | null; balance: string }>(tx, sql`
      select p.id, p.name, p.phone, p.gstin,
             coalesce((select sum(jl.debit - jl.credit) from journal_lines jl join journal_entries e on e.id = jl.entry_id
                        where jl.party_id = p.id and e.entry_date <= ${asOf}::date), 0)::text as balance
        from parties p`);
    const used = new Set<string>();
    for (const { row, values: v } of readFile('parties', csv)) {
      const gstin = v.gstin ? normaliseGstin(v.gstin) : null;
      const phone = v.phone ? normalisePhone(v.phone) : null;
      const p = balances.find((b) => (gstin && b.gstin === gstin) || (phone && b.phone === phone)) ?? balances.find((b) => key(b.name) === key(v.name ?? ''));
      const r = amount(v.receivable);
      const py = amount(v.payable);
      const b = amount(v.balance);
      const vy = r !== null || py !== null
        ? (r === 'bad' || r === null ? D(0) : r.abs()).minus(py === 'bad' || py === null ? D(0) : py.abs())
        : (b === 'bad' ? null : b ?? D(0));
      if (p) used.add(p.id);
      line(row, p?.name ?? v.name ?? '', vy, D(p?.balance ?? 0), Boolean(p));
    }
    for (const p of balances.filter((x) => !used.has(x.id) && !D(x.balance).isZero())) line(null, p.name, null, D(p.balance), true);
  } else if (kind === 'items') {
    const stock = await rows<{ id: string; sku: string; name: string; qty: string; value: string }>(tx, sql`
      select i.id, i.sku, i.name, coalesce(v.qty, 0)::text as qty, coalesce(v.value, 0)::text as value
        from items i left join v_item_valuation v on v.item_id = i.id where i.is_stock_item`);
    const used = new Set<string>();
    for (const { row, values: v } of readFile('items', csv)) {
      const it = stock.find((s) => v.sku && s.sku === v.sku.toUpperCase()) ?? stock.find((s) => key(s.name) === key(v.name ?? ''));
      const value = amount(v.value);
      const q = amount(v.qty);
      if (it) used.add(it.id);
      // Stock is compared by value; the quantity difference shows in the name when there is one.
      const qtyNote = it && q !== null && q !== 'bad' && !D(it.qty).eq(q) ? ` (quantity: Vyapar ${q.toString()}, RadCore ${D(it.qty).toString()})` : '';
      line(row, `${it?.name ?? v.name ?? ''}${qtyNote}`, value === 'bad' ? null : value ?? D(0), D(it?.value ?? 0), Boolean(it));
    }
    for (const s of stock.filter((x) => !used.has(x.id) && !D(x.value).isZero())) line(null, s.name, null, D(s.value), true);
  } else {
    const accts = await rows<{ id: string; code: string; name: string; balance: string }>(tx, sql`
      select a.id, a.code, a.name,
             coalesce((select sum(jl.debit - jl.credit) from journal_lines jl join journal_entries e on e.id = jl.entry_id
                        where jl.account_id = a.id and e.entry_date <= ${asOf}::date), 0)::text as balance
        from accounts a where not a.is_group`);
    for (const { row, values: v } of readFile('accounts', csv)) {
      const a = accts.find((x) => (v.code && x.code === v.code.trim()) || (v.account && key(x.name) === key(v.account)));
      const dr = amount(v.debit);
      const cr = amount(v.credit);
      const b = amount(v.balance);
      const vy = dr !== null || cr !== null
        ? (dr === 'bad' || dr === null ? D(0) : dr.abs()).minus(cr === 'bad' || cr === null ? D(0) : cr.abs())
        : (b === 'bad' ? null : b ?? D(0));
      line(row, a ? `${a.code} ${a.name}` : (v.account ?? v.code ?? ''), vy, D(a?.balance ?? 0), Boolean(a));
    }
  }
  const differ = out.filter((o) => !D(o.difference).isZero() || !o.found);
  return {
    rows: out,
    totals: {
      vyapar: money(out.reduce((s, o) => s.plus(o.vyapar ?? 0), D(0))),
      radcore: money(out.reduce((s, o) => s.plus(o.radcore), D(0))),
      differences: differ.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const zBody = z.object({
  csv: z.string().min(1, 'Choose the file').max(900_000, 'The file is too large: split it, or leave out columns that are not needed'),
  as_of: zDate,
  dry_run: z.boolean().prefault(true),
  location_id: zId.optional(),
});

export function openingRouter(db: DB) {
  const r = Router();

  /** The template for a step: its heading line and one example line. */
  r.get('/template/:kind', requirePerm('opening:import'), async (req, res) => {
    const kind = z.enum(['parties', 'items', 'accounts']).parse(req.params.kind);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="radcore-opening-${kind}.csv"`);
    res.send(TEMPLATES[kind]);
  });

  /**
   * Check a file (dry_run, the default: nothing is saved) or bring it in. A file with any problem is refused
   * whole; the check lists every row with what is wrong with it.
   */
  r.post('/:kind', requirePerm('opening:import'), async (req, res) => {
    const kind = z.enum(['parties', 'items', 'accounts']).parse(req.params.kind);
    const b = zBody.parse(req.body);
    const out = await inTx(db, req, async (ctx) => {
      const checked = kind === 'parties' ? await checkParties(ctx.tx, b.csv) : kind === 'items' ? await checkItems(ctx.tx, b.csv) : await checkAccounts(ctx.tx, b.csv);
      const listed = result<object>(checked);
      if (b.dry_run) return { ...listed, imported: null };
      if (listed.problems) {
        throw badRequest(`Nothing was brought in: ${listed.problems} problem(s) in the file. Check it to see them.`, { rows: listed.rows.filter((x) => x.problems.length) });
      }
      const imported = kind === 'parties' ? await importParties(ctx, checked as Checked<PartyRow>[], b.as_of)
        : kind === 'items' ? await importItems(ctx, checked as Checked<ItemRow>[], b.location_id ?? (await locationByType(ctx.tx, 'stores')))
        : await importAccounts(ctx, checked as Checked<AccountRow>[], b.as_of);
      await audit(ctx, 'opening_import', kind, 'import', null, { as_of: b.as_of, ...imported });
      return { ...listed, imported };
    });
    res.json({ data: out });
  });

  /** Vyapar's closing figures against RadCore's on a date: a party's balance, an item's stock value, an account's balance. */
  r.post('/compare/:kind', requirePerm('opening:import', 'audit:read'), async (req, res) => {
    const kind = z.enum(['parties', 'items', 'accounts']).parse(req.params.kind);
    const b = zBody.pick({ csv: true, as_of: true }).parse(req.body);
    res.json({ data: await compare(db, kind, b.csv, b.as_of) });
  });
  return r;
}
