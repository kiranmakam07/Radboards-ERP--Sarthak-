import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, fyOf, fyRange, istDate } from '@radcore/shared';
import { expectBooksHealthy, masters, setup, type World } from './helpers';

// Years are worked out from today's date, so the test keeps passing in any year it is run.
const today = istDate();
const thisFy = fyOf(today);
const lastFy = fyOf(addDays(fyRange(thisFy).from, -1));
const fyBefore = fyOf(addDays(fyRange(lastFy).from, -1));
const A = fyRange(fyBefore);
const B = fyRange(lastFy);

let w: World;
let acc: Record<string, string>;

beforeAll(async () => {
  w = await setup();
  const m = await masters(w.db);
  const accounts = await w.as('accounts');
  const chart = (await accounts.get('/api/accounting/accounts').expect(200)).body.data;
  const byName = (name: string) => chart.find((a: { name: string }) => a.name === name).id;
  acc = { bank: m.account('bank'), income: m.account('other_income'), retained: m.account('retained_earnings'), rent: byName('Rent'), salaries: byName('Salaries & Wages') };
  const post = (date: string, narration: string, debit: string, credit: string, amount: number) =>
    accounts.post('/api/accounting/journals').send({ entry_date: date, narration, lines: [{ account_id: debit, debit: amount }, { account_id: credit, credit: amount }] }).expect(201);
  // Year before last: earned 1,000, spent 400 -> profit 600.
  await post(addDays(A.from, 30), 'Consulting income', acc.bank!, acc.income!, 1000);
  await post(addDays(A.from, 60), 'Rent', acc.rent!, acc.bank!, 400);
  // Last year: earned 2,000, spent 2,500 -> loss 500.
  await post(addDays(B.from, 30), 'Consulting income', acc.bank!, acc.income!, 2000);
  await post(addDays(B.from, 60), 'Salaries', acc.salaries!, acc.bank!, 2500);
  // This year so far: earned 300.
  await post(fyRange(thisFy).from, 'Consulting income', acc.bank!, acc.income!, 300);
});
afterAll(() => w.close());

const years = async () => (await (await w.as('accounts')).get('/api/accounting/years').expect(200)).body.data as any[];
const tbAsOf = async (date: string) => {
  const res = await (await w.as('accounts')).get(`/api/accounting/reports/trial-balance?as_of=${date}`).expect(200);
  expect(res.body.balanced).toBe(true);
  return Object.fromEntries(res.body.data.map((a: { name: string; debit: string; credit: string }) => [a.name, Number(a.debit) - Number(a.credit)]));
};

describe('year-end close', () => {
  it('lists each year with its own profit and says which can be closed', async () => {
    const list = await years();
    expect(list.map((y) => [y.fy, y.status, y.profit, y.can_close])).toEqual([
      [thisFy, 'current', '300.00', false],
      [lastFy, 'ended', '-500.00', false], // the year before it is still open
      [fyBefore, 'ended', '600.00', true],
    ]);
    await (await w.as('sales')).get('/api/accounting/years').expect(403);
    await (await w.as('owner')).post(`/api/accounting/years/${fyBefore}/close`).send({}).expect(403);
  });

  it('closes only years that have ended, oldest first', async () => {
    const accounts = await w.as('accounts');
    const early = await accounts.post(`/api/accounting/years/${thisFy}/close`).send({}).expect(409);
    expect(early.body.error.message).toContain('It can be closed from the day after');
    const skipped = await accounts.post(`/api/accounting/years/${lastFy}/close`).send({}).expect(409);
    expect(skipped.body.error.message).toContain('oldest first');
    await accounts.post('/api/accounting/years/2026/close').send({}).expect(400);
    await accounts.post('/api/accounting/years/2026-28/close').send({}).expect(400);
  });

  it('moves the year\'s profit into Retained Earnings and locks the year', async () => {
    const accounts = await w.as('accounts');
    const done = await accounts.post(`/api/accounting/years/${fyBefore}/close`).send({}).expect(201);
    expect(done.body.data).toMatchObject({ fy: fyBefore, income: '1000.00', expense: '400.00', profit: '600.00' });
    expect(done.body.data.entry_id).toBeTruthy();

    const atYearEnd = await tbAsOf(A.to);
    expect(atYearEnd['Other Income']).toBeUndefined(); // emptied
    expect(atYearEnd.Rent).toBeUndefined();
    expect(atYearEnd['Retained Earnings']).toBe(-600); // a credit balance
    expect(atYearEnd['Bank Account']).toBe(600);

    // The year's own profit and loss still reads as it was; the closing entry is not part of what was earned or spent.
    const pl = (await accounts.get(`/api/accounting/reports/profit-and-loss?from=${A.from}&to=${A.to}`).expect(200)).body;
    expect(pl).toMatchObject({ total_income: '1000.00', total_expense: '400.00', net_profit: '600.00' });

    // Nothing more can be posted into the closed year.
    const settings = (await (await w.as('admin')).get('/api/settings').expect(200)).body.data;
    expect(settings.period_lock_date).toBe(A.to);
    const late = await accounts.post('/api/accounting/journals').send({ entry_date: A.to, narration: 'Too late', lines: [{ account_id: acc.rent, debit: 10 }, { account_id: acc.bank, credit: 10 }] }).expect(409);
    expect(late.body.error.code).toBe('period_locked');
    await accounts.post(`/api/accounting/years/${fyBefore}/close`).send({}).expect(409); // already closed
  });

  it('closes a loss-making year too, even when the books were already locked past its end', async () => {
    const accounts = await w.as('accounts');
    const admin = await w.as('admin');
    // Months are usually locked as they are finished, so by closing time the whole year is locked.
    await admin.put('/api/settings/period-lock').send({ period_lock_date: addDays(B.to, 10) }).expect(200);
    const done = await accounts.post(`/api/accounting/years/${lastFy}/close`).send({}).expect(201);
    expect(done.body.data).toMatchObject({ income: '2000.00', expense: '2500.00', profit: '-500.00' });
    const settings = (await admin.get('/api/settings').expect(200)).body.data;
    expect(settings.period_lock_date).toBe(addDays(B.to, 10)); // the later lock is kept, not pulled back

    const atYearEnd = await tbAsOf(B.to);
    expect(atYearEnd['Retained Earnings']).toBe(-100); // 600 profit, then 500 loss
    expect(atYearEnd['Other Income']).toBeUndefined();
    expect(atYearEnd['Salaries & Wages']).toBeUndefined();

    // Today: only this year's 300 shows as profit to date; earlier years sit in Retained Earnings.
    const bs = (await accounts.get('/api/accounting/reports/balance-sheet').expect(200)).body;
    expect(bs.balanced).toBe(true);
    expect(bs.equity).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Retained Earnings', amount: '100.00' }),
      expect.objectContaining({ name: 'Profit / (Loss) to date', amount: '300.00' }),
    ]));
    const dash = (await (await w.as('owner')).get(`/api/dashboards/accounts?from=${B.from}&to=${B.to}`).expect(200)).body.data.profit_and_loss;
    expect(Number(dash.net_profit)).toBe(-500);
    await expectBooksHealthy(w);
  });

  it('reopens the latest closed year only, with two people: Accounts asks, and someone else approves', async () => {
    const accounts = await w.as('accounts');
    const owner = await w.as('owner');
    const older = await accounts.post(`/api/accounting/years/${fyBefore}/reopen-request`).send({ reason: 'missed bill' }).expect(409);
    expect(older.body.error.message).toContain(`${lastFy} was closed after it`);

    // Accounts cannot reopen by itself, and the owner cannot reopen without a request.
    await accounts.post(`/api/accounting/years/${lastFy}/reopen`).send({}).expect(403);
    expect((await owner.post(`/api/accounting/years/${lastFy}/reopen`).send({}).expect(409)).body.error.message).toMatch(/needs a request from Accounts/);
    await accounts.post(`/api/accounting/years/${lastFy}/reopen-request`).send({}).expect(400); // the reason is required
    await accounts.post(`/api/accounting/years/${lastFy}/reopen-request`).send({ reason: 'A March bill was booked in April' }).expect(200);
    expect((await years()).find((y) => y.fy === lastFy).reopen_request).toMatchObject({ reason: 'A March bill was booked in April' });
    // An admin who asked cannot approve their own request.
    const admin = await w.as('admin');
    await accounts.post(`/api/accounting/years/${lastFy}/reopen-request/drop`).send({}).expect(200);
    await admin.post(`/api/accounting/years/${lastFy}/reopen-request`).send({ reason: 'checking' }).expect(200);
    expect((await admin.post(`/api/accounting/years/${lastFy}/reopen`).send({}).expect(403)).body.error.message).toMatch(/someone else must approve/);
    await owner.post(`/api/accounting/years/${lastFy}/reopen`).send({}).expect(200);
    const reopened = await tbAsOf(B.to);
    expect(reopened['Other Income']).toBe(-2000); // back as it was before the close
    expect(reopened['Salaries & Wages']).toBe(2500);
    expect(reopened['Retained Earnings']).toBe(-600);
    expect((await years()).map((y) => [y.fy, y.status, y.can_close, y.can_reopen])).toEqual([
      [thisFy, 'current', false, false], [lastFy, 'ended', true, false], [fyBefore, 'closed', false, true],
    ]);
    await owner.post(`/api/accounting/years/${lastFy}/reopen`).send({}).expect(409); // not closed any more

    await accounts.post(`/api/accounting/years/${lastFy}/close`).send({}).expect(201);
    expect((await tbAsOf(B.to))['Retained Earnings']).toBe(-100);
    const pl = (await accounts.get(`/api/accounting/reports/profit-and-loss?from=${B.from}&to=${B.to}`).expect(200)).body;
    expect(pl.net_profit).toBe('-500.00'); // closed, reopened and closed again: the year still reads the same
    await expectBooksHealthy(w);
  });
});
