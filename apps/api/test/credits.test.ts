import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectBooksHealthy, masters, openingStock, setup, type World } from './helpers';

let w: World;
const id: Record<string, string> = {};

/** Bill helmets (1,180 each, tax included) to a customer; `paid` is taken by UPI, the rest is on credit. */
async function bill(partyId: string, qty: number, paid: number) {
  const accounts = await w.as('accounts');
  const res = await accounts.post('/api/sales/quick-bill').send({
    party_id: partyId, lines: [{ item_id: id.helmet, qty }], payments: paid > 0 ? [{ mode: 'upi', amount: paid }] : [],
  }).expect(201);
  return { invoice: res.body.data.invoice as { id: string; invoice_no: string }, payments: res.body.data.payments as { id: string }[] };
}
const outstanding = async (invoiceId: string) =>
  Number((await (await w.as('accounts')).get(`/api/sales/invoices/${invoiceId}`).expect(200)).body.data.payment.outstanding);
const credits = async (invoiceId: string) => (await (await w.as('accounts')).get(`/api/sales/invoices/${invoiceId}/credits`).expect(200)).body.data;
const balance = async (partyId: string) => Number((await (await w.as('accounts')).get(`/api/parties/${partyId}`).expect(200)).body.data.balance);

beforeAll(async () => {
  w = await setup();
  const m = await masters(w.db);
  const admin = await w.as('admin');
  const accounts = await w.as('accounts');
  id.helmet = (await admin.post('/api/items').send({
    sku: 'HLM-1', name: 'Helmet', item_type: 'finished_good', hsn_sac: '650610', gst_rate: 18, retail_price: 1180, purchase_cost: 600,
  }).expect(201)).body.data.id;
  await openingStock(w, m.showroom, [{ item_id: id.helmet!, qty_change: '50', unit_cost: '600' }]);
  const party = (name: string, phone: string) => accounts.post('/api/parties').send({ party_type: 'customer', name, phone }).expect(201);
  id.riya = (await party('Riya Sen', '9855500001')).body.data.id;
  id.other = (await party('Someone Else', '9855500002')).body.data.id;
});
afterAll(() => w.close());

describe('using a credit note against another invoice', () => {
  it('a return on a paid invoice leaves the customer in credit', async () => {
    const accounts = await w.as('accounts');
    const first = await bill(id.riya!, 2, 2360); // paid in full
    id.inv1 = first.invoice.id;
    id.receipt1 = first.payments[0]!.id;
    const doc = (await accounts.get(`/api/sales/invoices/${id.inv1}`).expect(200)).body.data;
    const cn = await accounts.post(`/api/sales/invoices/${id.inv1}/credit-note`).send({
      lines: [{ invoice_line_id: doc.lines[0].id, qty: 1 }], reason: 'Wrong size',
    }).expect(201);
    id.cn = cn.body.data.id;
    expect(cn.body.data.grand_total).toBe('1180.00');
    expect(await balance(id.riya!)).toBe(-1180); // we owe her 1,180

    const second = await bill(id.riya!, 3, 0); // 3,540 on credit
    id.inv2 = second.invoice.id;
    expect(await outstanding(id.inv2)).toBe(3540);
    const c = await credits(id.inv2);
    expect(c.available).toHaveLength(1);
    expect(c.available[0]).toMatchObject({ credit_note_id: id.cn, amount: '1180.00', used: '0.00', available: '1180.00' });
    // On the invoice the note was raised against it is not offered: it already reduced that one.
    expect((await credits(id.inv1!)).available).toEqual([]);
  });

  it('sets the credit against the later invoice, without touching the books', async () => {
    const accounts = await w.as('accounts');
    await (await w.as('sales')).post(`/api/sales/invoices/${id.inv2}/apply-credit`).send({ credit_note_id: id.cn }).expect(403);
    const before = await expectBooksHealthy(w);
    const applied = await accounts.post(`/api/sales/invoices/${id.inv2}/apply-credit`).send({ credit_note_id: id.cn }).expect(201);
    id.application = applied.body.data.id;
    expect(applied.body.data.amount).toBe('1180.00');

    expect(await outstanding(id.inv2!)).toBe(2360);
    const doc = (await accounts.get(`/api/sales/invoices/${id.inv2}`).expect(200)).body.data;
    expect(doc.payment.payment_status).toBe('partly_paid');
    // What the invoices say she owes now matches what the ledger says, and no journal entry was needed.
    expect(await balance(id.riya!)).toBe(2360);
    const after = await expectBooksHealthy(w);
    expect(after.total_debit).toBe(before.total_debit);
    const ageing = (await accounts.get('/api/accounting/reports/receivables-ageing').expect(200)).body.data;
    expect(Number(ageing.find((r: { party_name: string }) => r.party_name === 'Riya Sen').total)).toBe(2360);

    const c = await credits(id.inv2!);
    expect(c.applied).toEqual([expect.objectContaining({ credit_note_id: id.cn, amount: '1180.00' })]);
    expect(c.available).toEqual([]);
    expect((await credits(id.cn!)).used_on).toEqual([expect.objectContaining({ invoice_id: id.inv2, amount: '1180.00' })]);
  });

  it('never lets the same credit be used twice, or on the wrong invoice', async () => {
    const accounts = await w.as('accounts');
    const again = await accounts.post(`/api/sales/invoices/${id.inv2}/apply-credit`).send({ credit_note_id: id.cn }).expect(409);
    expect(again.body.error.message).toContain('no unused credit');
    await accounts.post(`/api/sales/invoices/${id.inv1}/apply-credit`).send({ credit_note_id: id.cn }).expect(409); // its own invoice
    const theirs = await bill(id.other!, 1, 0);
    const wrong = await accounts.post(`/api/sales/invoices/${theirs.invoice.id}/apply-credit`).send({ credit_note_id: id.cn }).expect(409);
    expect(wrong.body.error.message).toContain('different customer');
    await accounts.post(`/api/sales/invoices/${id.inv2}/apply-credit`).send({ credit_note_id: id.inv1 }).expect(400); // not a credit note
  });

  it('protects credit that has been used: the receipt and the credit note behind it cannot be cancelled', async () => {
    const accounts = await w.as('accounts');
    const receipt = await accounts.post(`/api/payments/${id.receipt1}/cancel`).send({ reason: 'Bounced' }).expect(409);
    expect(receipt.body.error.message).toContain('has already been used against another invoice');
    const note = await accounts.post(`/api/sales/invoices/${id.cn}/cancel`).send({ reason: 'Mistake' }).expect(409);
    expect(note.body.error.message).toContain('has been used against');
    expect(await outstanding(id.inv2!)).toBe(2360); // nothing changed
  });

  it('can be taken back, and used in parts', async () => {
    const accounts = await w.as('accounts');
    await accounts.post(`/api/sales/credit-applications/${id.application}/take-back`).send({}).expect(200);
    await accounts.post(`/api/sales/credit-applications/${id.application}/take-back`).send({}).expect(409);
    expect(await outstanding(id.inv2!)).toBe(3540);

    await accounts.post(`/api/sales/invoices/${id.inv2}/apply-credit`).send({ credit_note_id: id.cn, amount: 5000 }).expect(409); // more than the credit
    await accounts.post(`/api/sales/invoices/${id.inv2}/apply-credit`).send({ credit_note_id: id.cn, amount: 500 }).expect(201);
    expect((await credits(id.inv2!)).available[0].available).toBe('680.00');
    const third = await bill(id.riya!, 1, 1000); // 1,180 billed, 180 left to pay
    const tooMuch = await accounts.post(`/api/sales/invoices/${third.invoice.id}/apply-credit`).send({ credit_note_id: id.cn, amount: 680 }).expect(409);
    expect(tooMuch.body.error.message).toContain('has only 180.00 outstanding');
    await accounts.post(`/api/sales/invoices/${third.invoice.id}/apply-credit`).send({ credit_note_id: id.cn }).expect(201); // uses 180
    expect(await outstanding(third.invoice.id)).toBe(0);
    expect((await credits(id.inv2!)).available[0].available).toBe('500.00');
    // Cancelling an invoice hands back the credit that was set against it. Cancel its receipt with it.
    await accounts.post(`/api/sales/invoices/${third.invoice.id}/cancel`).send({ reason: 'Customer changed her mind', restock: true, cancel_payments: true }).expect(200);
    expect((await credits(id.inv2!)).available[0].available).toBe('680.00');
    await expectBooksHealthy(w);
  });

  it('does not offer credit that was refunded in cash', async () => {
    const accounts = await w.as('accounts');
    // 680 of credit is unused. Refund 400 of it to her bank account.
    await accounts.post('/api/payments').send({ direction: 'out', party_id: id.riya, mode: 'bank_transfer', amount: 400 }).expect(201);
    expect((await credits(id.inv2!)).available[0].available).toBe('280.00');
    await accounts.post(`/api/sales/invoices/${id.inv2}/apply-credit`).send({ credit_note_id: id.cn, amount: 300 }).expect(409);
    await accounts.post(`/api/sales/invoices/${id.inv2}/apply-credit`).send({ credit_note_id: id.cn }).expect(201); // the 280 that is left
    expect(await outstanding(id.inv2!)).toBe(3540 - 500 - 280);
    expect(await balance(id.riya!)).toBe(3540 - 500 - 280);
    expect((await credits(id.inv2!)).available).toEqual([]);
    await expectBooksHealthy(w);
  });
});
