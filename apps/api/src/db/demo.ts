import { ROLES, addDays, addMonths, gstinCheckChar, istDate, type Role } from '@radcore/shared';
import { hashPassword } from '../core/auth';
import { setSetting } from '../core/settings';
import type { Ctx } from '../lib/http';
import { createAdjustment, decideAdjustment } from '../modules/inventory';
import { createApplicant, createEmployee, hireApplicant, moveApplicant, saveAttendance, scheduleInterview } from '../modules/hr';
import { captureLead, sourceIdByName } from '../modules/leads';
import { createParty } from '../modules/parties';
import { rows, sql, type DB } from './client';
import { assets, items, jobOpenings, maintenanceSchedules, taskTemplates, tasks, users } from './schema';

/**
 * Sample data for trying the system out. Used ONLY by `npm run demo`, which runs on a
 * throwaway in-memory database - never against real data.
 *
 * Demo sign-in: phone 9000000000 .. 9000000008 (one per role, in the order of ROLES:
 * owner, marketing, store, sales, stores, accounts, admin, hr, operations), password below.
 */
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'radcore-demo';

const gstin = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckChar(`${state}${pan}1Z`)}`;

export async function seedDemo(db: DB): Promise<void> {
  const hash = await hashPassword(DEMO_PASSWORD);
  await db.insert(users).values(
    ROLES.map((role, i) => ({ name: `Demo ${role[0]!.toUpperCase()}${role.slice(1)}`, phone: `+91900000000${i}`, passwordHash: hash, role })),
  );
  const [admin] = await rows<{ id: string; name: string; phone: string }>(db, sql`select id, name, phone from users where role = 'admin' limit 1`);

  await setSetting(db, 'company', {
    name: 'Radboards Pvt Ltd (DEMO)', gstin: gstin('27', 'AAPFU0939F'), state_code: '27',
    address: { line1: '12 Skate Street', city: 'Pune', state: 'Maharashtra', pincode: '411001' },
    phone: '+91 20 5550 0100', email: 'accounts@example.com',
    bank: { bank_name: 'Demo Bank', account_no: '000111222333', ifsc: 'DEMO0000001', account_name: 'Radboards Pvt Ltd' },
    invoice_terms: 'Goods once sold are covered by the manufacturer warranty only.',
  }, admin!.id);

  await db.transaction(async (tx) => {
    const ctx: Ctx = { tx: tx as unknown as DB, user: { id: admin!.id, name: admin!.name, phone: admin!.phone, role: 'admin' } };
    const created = await ctx.tx
      .insert(items)
      .values([
        { sku: 'BRD-CRUISER', name: 'Cruiser Board 27"', itemType: 'finished_good', hsnSac: '950699', gstRate: '18', purchaseCost: '2500', mrp: '6499', retailPrice: '5900', dealerPrice: '4000', reorderLevel: '5', barcode: '8900000000011' },
        { sku: 'BRD-LONG', name: 'Longboard 42"', itemType: 'finished_good', hsnSac: '950699', gstRate: '18', purchaseCost: '4200', mrp: '10999', retailPrice: '9440', dealerPrice: '6800', reorderLevel: '3', barcode: '8900000000028' },
        { sku: 'WHL-60', name: 'Wheel Set 60mm', itemType: 'spare_part', hsnSac: '950699', gstRate: '12', purchaseCost: '500', mrp: '1299', retailPrice: '1120', dealerPrice: '800', reorderLevel: '10', barcode: '8900000000035' },
        { sku: 'HLM-01', name: 'Helmet', itemType: 'finished_good', hsnSac: '650610', gstRate: '18', purchaseCost: '700', mrp: '1799', retailPrice: '1534', dealerPrice: '1100', reorderLevel: '5', barcode: '8900000000042' },
        { sku: 'RM-MAPLE', name: 'Maple Ply Sheet', itemType: 'raw_material', hsnSac: '441239', gstRate: '18', unit: 'Sheet', purchaseCost: '900', reorderLevel: '20' },
        { sku: 'SVC-SETUP', name: 'Board Setup & Tuning', itemType: 'service', hsnSac: '998729', gstRate: '18', retailPrice: '236', isStockItem: false },
      ])
      .returning({ id: items.id, sku: items.sku, cost: items.purchaseCost });
    const id = (sku: string) => created.find((i) => i.sku === sku)!.id;

    await createParty(ctx, { party_type: 'supplier', name: 'Deck Makers Pvt Ltd', phone: '+919700000001', gstin: gstin('27', 'SUPPL1234A'), payment_terms_days: 30, billing_address: { line1: 'MIDC Bhosari', line2: '', city: 'Pune', state: 'Maharashtra', pincode: '411026' } });
    await createParty(ctx, { party_type: 'dealer', name: 'Bangalore Boards', phone: '+919700000002', gstin: gstin('29', 'DEALR1234B'), credit_limit: '100000.00', payment_terms_days: 15, billing_address: { line1: 'Indiranagar', line2: '', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' } });
    await createParty(ctx, { party_type: 'dealer', name: 'Mumbai Skate Co', phone: '+919700000003', gstin: gstin('27', 'DEALR5678C'), credit_limit: '50000.00', payment_terms_days: 7 });

    const loc = await rows<{ id: string; type: string }>(ctx.tx, sql`select id, type from locations`);
    const at = (type: string) => loc.find((l) => l.type === type)!.id;
    const opening = async (locationId: string, lines: [string, number][]) => {
      const adj = await createAdjustment(ctx, {
        kind: 'opening', locationId, reason: 'Opening stock (demo)',
        lines: lines.map(([sku, qty]) => ({ itemId: id(sku), qtyChange: String(qty), unitCost: created.find((i) => i.sku === sku)!.cost })),
      });
      await decideAdjustment(ctx, adj.id, true);
    };
    await opening(at('stores'), [['BRD-CRUISER', 20], ['BRD-LONG', 8], ['WHL-60', 40], ['HLM-01', 15], ['RM-MAPLE', 60]]);
    await opening(at('showroom'), [['BRD-CRUISER', 6], ['BRD-LONG', 2], ['WHL-60', 12], ['HLM-01', 6]]);

    const lead = (name: string, phone: string, source: string, detail: string | null, sku: string) =>
      sourceIdByName(ctx.tx, source).then((sourceId) =>
        captureLead({ tx: ctx.tx, user: null }, { name, phone, sourceId, sourceDetail: detail, interestedItemIds: [id(sku)] }));
    await lead('Asha Rao', '+919820011111', 'Meta Ads', 'Diwali campaign', 'BRD-CRUISER');
    await lead('Vikram Shah', '+919820022222', 'Google Ads', 'Longboard search', 'BRD-LONG');
    await lead('Neha Kulkarni', '+919820033333', 'Instagram Collab', '@skate.pune', 'HLM-01');
    await lead('Imran Khan', '+919820044444', 'Website', null, 'BRD-CRUISER');

    await seedPeopleAndOperations(ctx);
  });
  console.log(`Demo data loaded (${istDate()}). Sign in with phone 9000000006 (admin) and the demo password.`);
}

/** HR and operations sample data: a hiring pipeline at every stage, staff with a week of attendance, routines and machines. */
async function seedPeopleAndOperations(ctx: Ctx): Promise<void> {
  const { tx } = ctx;
  const today = istDate();
  const staff = await rows<{ id: string; role: Role }>(tx, sql`select id, role from users`);
  const user = (role: Role) => staff.find((u) => u.role === role)!.id;
  const inDays = (n: number, hour: number) => new Date(`${addDays(today, n)}T${String(hour).padStart(2, '0')}:00:00+05:30`);

  // ---- hiring ----
  const [sales, workshop] = await tx.insert(jobOpenings).values([
    { title: 'Showroom Sales Executive', department: 'Sales', positions: 2, openedOn: addDays(today, -12) },
    { title: 'Workshop Technician', department: 'Production', positions: 1, openedOn: addDays(today, -5) },
  ]).returning({ id: jobOpenings.id });
  const applicant = (name: string, phone: string, source: 'job_portal' | 'referral' | 'walk_in' | 'social_media', openingId: string, daysAgo: number, years: string) =>
    createApplicant(ctx, { name, phone, source, openingId, appliedOn: addDays(today, -daysAgo), experienceYears: years, ownerId: user('hr') });
  const kiran = await applicant('Kiran Joshi', '+919811100001', 'job_portal', sales!.id, 10, '3.0');
  const meera = await applicant('Meera Pillai', '+919811100002', 'referral', sales!.id, 8, '1.5');
  const tarun = await applicant('Tarun Gill', '+919811100003', 'walk_in', sales!.id, 6, '0.5');
  const zoya = await applicant('Zoya Mirza', '+919811100004', 'social_media', sales!.id, 3, '2.0');
  await applicant('Farhan Qureshi', '+919811100005', 'job_portal', workshop!.id, 2, '4.0');
  await applicant('Lata Bhosle', '+919811100006', 'job_portal', workshop!.id, 0, '6.0');

  const first = await scheduleInterview(ctx, kiran.id, { title: 'Sales manager round', scheduledAt: inDays(-4, 11), interviewerId: user('sales') });
  await tx.execute(sql`update interviews set status = 'completed', result = 'pass', rating = 4, feedback = 'Confident, knows the products', completed_at = now() where id = ${first.id}`);
  await moveApplicant(ctx, kiran.id, { stage: 'offered' });
  await hireApplicant(ctx, kiran.id, { joinDate: addDays(today, -1), department: 'Sales', designation: 'Showroom Sales Executive', monthlySalary: '26000.00' });
  await scheduleInterview(ctx, meera.id, { title: 'Sales manager round', scheduledAt: inDays(1, 11), interviewerId: user('sales') });
  await moveApplicant(ctx, tarun.id, { stage: 'rejected', rejectReason: 'not_qualified', note: 'No retail experience' });
  await moveApplicant(ctx, zoya.id, { stage: 'shortlisted' });

  // ---- staff and a week of attendance ----
  const people = [
    await createEmployee(ctx, { name: 'Sunita Rao', phone: '+919822200001', department: 'Showroom', designation: 'Store Manager', joinDate: '2024-06-01', monthlySalary: '38000.00', userId: user('store') }),
    await createEmployee(ctx, { name: 'Amit Verma', phone: '+919822200002', department: 'Sales', designation: 'Dealer Sales Lead', joinDate: '2023-11-15', monthlySalary: '45000.00', userId: user('sales') }),
    await createEmployee(ctx, { name: 'Ganesh Pawar', phone: '+919822200003', department: 'Stores', designation: 'Stores In-charge', joinDate: '2022-04-01', monthlySalary: '32000.00', userId: user('stores') }),
    await createEmployee(ctx, { name: 'Rekha Shah', phone: '+919822200004', department: 'Accounts', designation: 'Accountant', joinDate: '2021-08-10', monthlySalary: '42000.00', userId: user('accounts') }),
  ];
  for (let back = 6; back >= 1; back--) {
    const day = addDays(today, -back);
    const sunday = new Date(`${day}T00:00:00Z`).getUTCDay() === 0;
    await saveAttendance(ctx, day, people.map((p, i) => (
      sunday ? { employeeId: p.id, status: 'weekly_off' as const }
        : (back + i) % 5 === 0 ? { employeeId: p.id, status: 'leave' as const }
          : (back + i) % 4 === 0 ? { employeeId: p.id, status: 'half_day' as const, checkIn: '09:30', checkOut: '13:30' }
            : { employeeId: p.id, status: 'present' as const, checkIn: '09:30', checkOut: '18:30' })));
  }

  // ---- routines: today's tasks are created the first time anyone opens a task screen ----
  const openingChecklist = ['Lights and display screens on', 'Count the cash float', 'Wipe down the demo boards'];
  const [opening] = await tx.insert(taskTemplates).values([
    { title: 'Open the showroom', frequency: 'daily', weekdays: [0, 1, 2, 3, 4, 5, 6], assigneeId: user('store'), startDate: addDays(today, -30), checklist: openingChecklist },
    { title: 'Bank the cash from yesterday', frequency: 'daily', weekdays: [1, 2, 3, 4, 5, 6], assigneeId: user('accounts'), startDate: addDays(today, -30), checklist: ['Deposit slip filed'] },
    { title: 'Count the fast-moving items', frequency: 'weekly', weekdays: [1], assigneeId: user('stores'), startDate: addDays(today, -30), checklist: [] },
    { title: 'File GSTR-3B and pay GST', frequency: 'monthly', monthDay: 20, assigneeId: user('accounts'), startDate: addDays(today, -30), checklist: ['GSTR-1 filed', 'Challan paid'] },
    { title: 'Receive a container', frequency: 'need_based', assigneeId: user('stores'), startDate: today, checklist: ['Check the seal number', 'Count cartons against the packing list'] },
  ]).returning({ id: taskTemplates.id });
  // A little history, so the charts have something to show: the opening routine over the last week, with yesterday missed.
  await tx.insert(tasks).values([6, 5, 4, 3, 2, 1].map((back) => {
    const day = addDays(today, -back);
    const done = back !== 1;
    return {
      templateId: opening!.id, scheduledFor: day, title: 'Open the showroom', assigneeId: user('store'), dueDate: day,
      status: done ? 'done' as const : 'open' as const, completedAt: done ? new Date(`${day}T04:30:00Z`) : null, completedBy: done ? user('store') : null,
      checklist: openingChecklist.map((text) => ({ text, done })),
    };
  }));

  // ---- machines ----
  const [router, van] = await tx.insert(assets).values([
    { assetNo: 'AST001', name: 'CNC Router', category: 'Machine', location: 'Workshop', serialNo: 'CNC-7781', purchaseDate: '2023-02-10', purchaseCost: '450000.00' },
    { assetNo: 'AST002', name: 'Delivery Van (MH12 AB 1234)', category: 'Vehicle', location: 'Stores', purchaseDate: '2022-09-01', purchaseCost: '780000.00' },
    { assetNo: 'AST003', name: 'Air Compressor', category: 'Machine', location: 'Workshop', purchaseDate: '2024-01-20', purchaseCost: '65000.00' },
  ]).returning({ id: assets.id });
  await tx.execute(sql`insert into number_series (doc_type, fy, prefix, next_value) values ('asset', 'ALL', 'AST', 4)`);
  await tx.insert(maintenanceSchedules).values([
    { assetId: router!.id, title: 'Full service', intervalCount: 6, intervalUnit: 'months', lastDoneOn: addMonths(addDays(today, -4), -6), nextDueOn: addDays(today, -4), assigneeId: user('operations'), remindDaysBefore: 14, instructions: 'Call the vendor engineer. Check spindle bearings and rails.' },
    { assetId: van!.id, title: 'Insurance renewal', intervalCount: 12, intervalUnit: 'months', nextDueOn: addDays(today, 9), assigneeId: user('accounts'), remindDaysBefore: 30 },
    { assetId: van!.id, title: 'Service and oil change', intervalCount: 4, intervalUnit: 'months', lastDoneOn: addMonths(today, -1), nextDueOn: addMonths(today, 3), assigneeId: user('operations'), remindDaysBefore: 10 },
  ]);
}
