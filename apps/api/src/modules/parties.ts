import { eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { PARTY_TYPES, STATE_CODES, can, isValidPan, normalisePan, stateCodeFromGstin } from '@radcore/shared';
import { audit } from '../core/audit';
import { requirePerm } from '../core/auth';
import { getCompany } from '../core/settings';
import { rows, type DB } from '../db/client';
import { parties } from '../db/schema';
import { badRequest, forbidden, must } from '../lib/errors';
import {
  emptyToNull, inTx, sendList, zAddress, zDate, zGstin, zId, zListQuery, zMoney, zPhone, zStateCode, zText, wantsFile, type Ctx,
} from '../lib/http';

/**
 * Parties: everyone we sell to or buy from (customer, dealer, supplier), with the details a tax
 * invoice needs and the terms a sale checks (price list, credit limit, payment terms).
 * A party's balance is not kept here: it is read from the books (partyBalance).
 */

export type Party = typeof parties.$inferSelect;

const zParty = z.object({
  party_type: z.enum(PARTY_TYPES),
  name: zText(200),
  phone: emptyToNull(zPhone).optional(),
  email: emptyToNull(z.string().email().max(200)).optional(),
  gstin: emptyToNull(zGstin).optional(),
  // Asked for on TDS returns. With a GSTIN it is read from that, so this is for parties without one.
  pan: emptyToNull(z.string().trim().transform(normalisePan).refine(isValidPan, 'PAN must look like ABCDE1234F')).optional(),
  state_code: emptyToNull(zStateCode).optional(),
  billing_address: zAddress.nullish(),
  shipping_address: zAddress.nullish(),
  price_list_id: emptyToNull(zId).optional(),
  credit_limit: emptyToNull(zMoney).optional(),
  payment_terms_days: emptyToNull(z.coerce.number().int().min(0).max(365)).optional(),
  active: z.boolean().optional(),
});
export type PartyInput = z.infer<typeof zParty>;

/**
 * State code drives place of supply (PRD 8.2): read from the GSTIN when there is one,
 * otherwise the one given, otherwise the company's own state (a local customer).
 */
async function resolveStateCode(tx: DB, gstin: string | null | undefined, given: string | null | undefined) {
  const fromGstin = gstin ? stateCodeFromGstin(gstin) : null;
  if (fromGstin) {
    if (given && given !== fromGstin) throw badRequest(`State code ${given} does not match the GSTIN (${fromGstin})`);
    return fromGstin;
  }
  if (given) {
    if (!STATE_CODES[given]) throw badRequest('Unknown state code');
    return given;
  }
  return (await getCompany(tx)).state_code;
}

/** Add a customer, dealer or supplier. Called from the Parties screen, from converting a lead, and when an online order brings a new customer. */
export async function createParty(ctx: Ctx, input: PartyInput & { lead_id?: string | null }): Promise<Party> {
  const stateCode = await resolveStateCode(ctx.tx, input.gstin, input.state_code);
  const [row] = await ctx.tx
    .insert(parties)
    .values({
      partyType: input.party_type,
      name: input.name,
      phone: input.phone ?? null,
      email: input.email ?? null,
      gstin: input.gstin ?? null,
      pan: input.pan ?? null,
      stateCode,
      billingAddress: input.billing_address ?? null,
      shippingAddress: input.shipping_address ?? null,
      priceListId: input.price_list_id ?? null,
      creditLimit: input.credit_limit ?? null,
      paymentTermsDays: input.payment_terms_days ?? null,
      leadId: input.lead_id ?? null,
      createdBy: ctx.user?.id ?? null,
    })
    .returning();
  await audit(ctx, 'party', row!.id, 'create', null, row);
  return row!;
}

/** Party balance from the journal: positive = they owe us (Dr), negative = we owe them (Cr). */
export async function partyBalance(tx: DB, partyId: string): Promise<string> {
  const [r] = await rows<{ balance: string }>(tx, sql`
    select coalesce(sum(debit) - sum(credit), 0)::numeric(14,2)::text as balance from journal_lines where party_id = ${partyId}`);
  return r?.balance ?? '0.00';
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function partiesRouter(db: DB) {
  const r = Router();

  r.get('/', requirePerm('parties:read'), async (req, res) => {
    const q = zListQuery.extend({
      type: z.enum(PARTY_TYPES).optional(),
      // Who we sell to (customers and dealers together) or who we buy from.
      side: emptyToNull(z.enum(['customers', 'suppliers'])).optional(),
      active: z.enum(['true', 'false', 'all']).default('true'),
    }).parse(req.query);
    const like = q.q ? `%${q.q}%` : null;
    const digits = q.q ? q.q.replace(/\D/g, '') : '';
    const phoneLike = digits.length >= 4 ? `%${digits}%` : null;
    const data = await rows(db, sql`
      select p.*, coalesce(b.balance, 0) as balance, pl.name as price_list_name
        from parties p
        left join v_party_balances b on b.party_id = p.id
        left join price_lists pl on pl.id = p.price_list_id
       where (${q.type ?? null}::text is null or p.party_type::text = ${q.type ?? null})
         and (${q.side ?? null}::text is null or (p.party_type = 'supplier') = (${q.side ?? null} = 'suppliers'))
         and (${q.active} = 'all' or p.active = (${q.active} = 'true'))
         and (${like}::text is null or p.name ilike ${like} or p.gstin ilike ${like}
              or (${phoneLike}::text is not null and p.phone like ${phoneLike}))
       order by p.name
       limit ${q.limit} offset ${q.offset}`);
    sendList(req, res, data, 'parties');
  });

  r.get('/:id', requirePerm('parties:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const [party] = await db.select().from(parties).where(eq(parties.id, id));
    must(party, 'Party');
    const open_invoices = await rows(db, sql`
      select invoice_id, invoice_no, invoice_date, due_date, grand_total, outstanding, payment_status
        from v_invoice_outstanding where party_id = ${id} and outstanding > 0 order by invoice_date`);
    const open_bills = await rows(db, sql`
      select bill_id, bill_no, supplier_invoice_no, bill_date, due_date, grand_total, outstanding, payment_status
        from v_bill_outstanding where supplier_id = ${id} and outstanding > 0 order by bill_date`);
    res.json({ data: { ...party, balance: await partyBalance(db, id), open_invoices, open_bills } });
  });

  /**
   * Anyone who sells or buys can add a new customer or supplier while working. The commercial
   * terms (price list, credit limit, payment days) belong to the master and need its permission.
   */
  r.post('/', requirePerm('parties:write', 'parties:manage'), async (req, res) => {
    const body = zParty.parse(req.body);
    const terms = body.price_list_id != null || body.credit_limit != null || body.payment_terms_days != null;
    if (terms && !can(req.user!.role, 'parties:manage')) {
      throw forbidden('A price list, credit limit or payment terms can only be set in Masters');
    }
    const created = await inTx(db, req, (ctx) => createParty(ctx, body));
    res.status(201).json({ data: created });
  });

  r.patch('/:id', requirePerm('parties:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const body = zParty.omit({ party_type: true }).partial().parse(req.body);
    const updated = await inTx(db, req, async (ctx) => {
      const [before] = await ctx.tx.select().from(parties).where(eq(parties.id, id)).for('update');
      must(before, 'Party');
      const gstin = body.gstin === undefined ? before!.gstin : body.gstin;
      const stateGiven = body.state_code === undefined ? (gstin ? null : before!.stateCode) : body.state_code;
      const stateCode = await resolveStateCode(ctx.tx, gstin, stateGiven);
      const patch: Partial<typeof parties.$inferInsert> = { stateCode, updatedAt: new Date() };
      if (body.name !== undefined) patch.name = body.name;
      if (body.phone !== undefined) patch.phone = body.phone;
      if (body.email !== undefined) patch.email = body.email;
      if (body.gstin !== undefined) patch.gstin = body.gstin;
      if (body.pan !== undefined) patch.pan = body.pan;
      if (body.billing_address !== undefined) patch.billingAddress = body.billing_address;
      if (body.shipping_address !== undefined) patch.shippingAddress = body.shipping_address;
      if (body.price_list_id !== undefined) patch.priceListId = body.price_list_id;
      if (body.credit_limit !== undefined) patch.creditLimit = body.credit_limit;
      if (body.payment_terms_days !== undefined) patch.paymentTermsDays = body.payment_terms_days;
      if (body.active !== undefined) patch.active = body.active;
      const [row] = await ctx.tx.update(parties).set(patch).where(eq(parties.id, id)).returning();
      await audit(ctx, 'party', id, 'update', before, row);
      return row;
    });
    res.json({ data: updated });
  });

  /** Party ledger with running balance (PRD 7.8). Needs accounts access - it shows money. */
  r.get('/:id/ledger', requirePerm('accounts:read'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const q = z.object({ from: zDate.optional(), to: zDate.optional() }).parse(req.query);
    must((await db.select({ id: parties.id }).from(parties).where(eq(parties.id, id)))[0], 'Party');
    const [opening] = await rows<{ balance: string }>(db, sql`
      select coalesce(sum(l.debit) - sum(l.credit), 0)::numeric(14,2) as balance
        from journal_lines l join journal_entries e on e.id = l.entry_id
       where l.party_id = ${id} and ${q.from ?? null}::date is not null and e.entry_date < ${q.from ?? null}::date`);
    const data = await rows(db, sql`
      select e.entry_date, e.entry_no, e.ref_type, e.ref_id, e.narration, a.name as account, l.debit, l.credit,
             (${opening?.balance ?? '0'}::numeric + sum(l.debit - l.credit) over (order by e.entry_date, e.entry_no, l.id))::numeric(14,2) as balance
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
        join accounts a on a.id = l.account_id
       where l.party_id = ${id}
         and (${q.from ?? null}::date is null or e.entry_date >= ${q.from ?? null}::date)
         and (${q.to ?? null}::date is null or e.entry_date <= ${q.to ?? null}::date)
       order by e.entry_date, e.entry_no, l.id`);
    if (wantsFile(req)) return sendList(req, res, data, 'party-ledger');
    res.json({ data, opening_balance: opening?.balance ?? '0.00', closing_balance: await partyBalance(db, id) });
  });
  return r;
}
