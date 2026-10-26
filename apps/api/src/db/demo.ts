import crypto from 'node:crypto';
import { ROLES, addDays, addMonths, gstinCheckChar, istDate, type Role } from '@radcore/shared';
import { hashPassword } from '../core/auth';
import { setSetting } from '../core/settings';
import type { Ctx } from '../lib/http';
import { unitEvent } from '../core/units';
import { createAdjustment, decideAdjustment } from '../modules/inventory';
import { createApplicant, createEmployee, hireApplicant, moveApplicant, saveAttendance, scheduleInterview } from '../modules/hr';
import { captureLead, sourceIdByName } from '../modules/leads';
import { fromShopify, takeOrder, type OnlineOrder } from '../modules/online';
import { createParty } from '../modules/parties';
import { rows, sql, type DB } from './client';
import { seedService } from './demo-service';
import {
  adSpends, allocations, assets, campaigns, channelEvents, items, jobOpenings, maintenanceSchedules, projects, taskTemplates, tasks, units, users,
} from './schema';

/**
 * Sample data for trying the system out. Used ONLY by `npm run demo`, which runs on a
 * throwaway in-memory database - never against real data.
 *
 * Demo sign-in: phone 9000000000 .. 9000000008 (one per role, in the order of ROLES:
 * owner, marketing, store, sales, stores, accounts, admin, hr, operations), password below.
 */
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'radcore-demo';

const gstin = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckChar(`${state}${pan}1Z`)}`;

export async function seedDemo(db: DB, password: string = DEMO_PASSWORD): Promise<void> {
  const hash = await hashPassword(password);
  await db.insert(users).values(
    // Phones 9000000000, 9000000001, ... one per role in the order of ROLES (9000000010 for the eleventh).
    ROLES.map((role, i) => ({ name: role === 'hr' ? 'Demo HR' : `Demo ${role[0]!.toUpperCase()}${role.slice(1).replace('_', ' ')}`, phone: `+919000000${String(i).padStart(3, '0')}`, passwordHash: hash, role })),
  );
  const [admin] = await rows<{ id: string; name: string; phone: string }>(db, sql`select id, name, phone from users where role = 'admin' limit 1`);

  await setSetting(db, 'sample_data', true, admin!.id);
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

    // The EV range, kept by serial number: scooters on the showroom floor, spare battery packs in stores
    // (a pack needs a storage charge every 30 days; one is late, so the home screen shows the alert).
    const [scooter, pack, motor] = await ctx.tx.insert(items).values([
      { sku: 'EV-S1', name: 'Electric Scooter S1', itemType: 'vehicle', hsnSac: '871160', gstRate: '5', purchaseCost: '62000', mrp: '92000', retailPrice: '89250', dealerPrice: '76000', reorderLevel: '2', isSerialised: true },
      { sku: 'BAT-60V', name: 'Battery Pack 60V 30Ah', itemType: 'sub_assembly', hsnSac: '850760', gstRate: '18', purchaseCost: '18000', retailPrice: '27140', dealerPrice: '21000', isSerialised: true, chargeEveryDays: 30 },
      { sku: 'MTR-2K', name: 'Hub Motor 2 kW', itemType: 'sub_assembly', hsnSac: '850152', gstRate: '18', purchaseCost: '9000', isSerialised: true },
    ]).returning();
    for (const [where, lines] of [
      [at('showroom'), [{ itemId: scooter!.id, qtyChange: '3', unitCost: '62000', serials: ['S1-24A0101', 'S1-24A0102', 'S1-24A0103'] }]],
      [at('stores'), [{ itemId: pack!.id, qtyChange: '2', unitCost: '18000', serials: ['BP60-7781', 'BP60-7782'] }]],
    ] as const) {
      const adj = await createAdjustment(ctx, { kind: 'opening', locationId: where, reason: 'Opening stock (demo)', lines: lines.map((l) => ({ ...l, serials: [...l.serials] })) });
      await decideAdjustment(ctx, adj.id, true);
    }
    // What the first scooter is made of: its battery pack (with its BPAN) and its motor.
    const [s1] = await rows<{ id: string }>(ctx.tx, sql`select id from units where serial_no = 'S1-24A0101'`);
    const [fittedPack] = await ctx.tx.insert(units).values({ itemId: pack!.id, serialNo: 'BP60-1001', parentUnitId: s1!.id, bpan: 'IN60V30AHLFP00001001A', firmwareVersion: 'BMS 3.2', status: 'available' }).returning();
    const [fittedMotor] = await ctx.tx.insert(units).values({ itemId: motor!.id, serialNo: 'MT2K-5531', parentUnitId: s1!.id, status: 'available' }).returning();
    for (const u of [fittedPack!, fittedMotor!]) await unitEvent(ctx, { unitId: u.id, event: 'fitted', refType: 'unit', refId: s1!.id, note: 'Recorded inside S1-24A0101' });
    await ctx.tx.execute(sql`update units set last_charged_on = ${addDays(istDate(), -34)}::date where serial_no = 'BP60-7781'`);

    const lead = (name: string, phone: string, source: string, detail: string | null, sku: string) =>
      sourceIdByName(ctx.tx, source).then((sourceId) =>
        captureLead({ tx: ctx.tx, user: null }, { name, phone, sourceId, sourceDetail: detail, interestedItemIds: [id(sku)] }));
    await lead('Asha Rao', '+919820011111', 'Meta Ads', 'Diwali campaign', 'BRD-CRUISER');
    await lead('Vikram Shah', '+919820022222', 'Google Ads', 'Longboard search', 'BRD-LONG');
    await lead('Neha Kulkarni', '+919820033333', 'Instagram Collab', '@skate.pune', 'HLM-01');
    await lead('Imran Khan', '+919820044444', 'Website', null, 'BRD-CRUISER');

    // Ad spend, so the marketing dashboard shows what a lead costs.
    const sourceId = async (name: string) => sourceIdByName(ctx.tx, name);
    // Campaign links, each with its own enquiry form and QR code.
    const link = async (name: string, source: string) =>
      ({ name, sourceId: await sourceId(source), token: crypto.randomBytes(12).toString('base64url'), createdBy: admin!.id });
    await ctx.tx.insert(campaigns).values([
      await link('Diwali pamphlets, Pune', 'Offline Campaign'),
      await link('Website enquiry form', 'Website'),
      await link('Longboard search ads', 'Google Ads'),
    ]);
    await ctx.tx.insert(adSpends).values([
      { sourceId: await sourceId('Meta Ads'), detail: 'Diwali campaign', spendDate: istDate(), amount: '1800.00', createdBy: admin!.id },
      { sourceId: await sourceId('Google Ads'), detail: 'Longboard search', spendDate: istDate(), amount: '1250.00', createdBy: admin!.id },
      { sourceId: await sourceId('Instagram Collab'), spendDate: istDate(), amount: '3000.00', notes: 'Fee for the reel', createdBy: admin!.id },
    ]);

    // What the Lead sources screen looks like once the connections are live: three arrivals and one that could not be used.
    const byPhone = await rows<{ id: string; phone: string }>(ctx.tx, sql`select id, phone from leads`);
    const leadId = (phone: string) => byPhone.find((l) => l.phone === phone)!.id;
    await ctx.tx.insert(channelEvents).values([
      { channel: 'meta', eventType: 'leadgen', externalId: 'demo-1001', payload: {}, status: 'processed', leadId: leadId('+919820011111'), summary: 'Asha Rao, +919820011111 · Diwali campaign', attempts: 1, processedAt: new Date() },
      { channel: 'google', eventType: 'lead', externalId: 'demo-g-1', payload: {}, status: 'processed', leadId: leadId('+919820022222'), summary: 'Vikram Shah, +919820022222 · Longboard search', attempts: 1, processedAt: new Date() },
      { channel: 'whatsapp', eventType: 'message', externalId: 'demo-wamid-1', payload: {}, status: 'ignored', summary: 'Sam, +14155550123', error: '+14155550123 is not an Indian mobile number', attempts: 1 },
    ]);

    await seedPeopleAndOperations(ctx);
    await seedOnlineOrders(ctx);
    await seedService(ctx);
  });
  console.log(`Demo data loaded (${istDate()}). Sign in with phone 9000000006 (admin) and the demo password.`);
}

/**
 * A review copy on a real server (SEED_DEMO_DATA=true): the same sample data, loaded once into
 * a database that has no users yet, so there is something to click through. It never touches a
 * database that is already in use, and it will not start with the well-known demo password.
 * Sign-in is phone 9000000000 to 9000000008 (one per role) with DEMO_PASSWORD.
 */
export async function seedReviewCopy(db: DB): Promise<'loaded' | 'already in use'> {
  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length > 0) return 'already in use';
  const password = process.env.DEMO_PASSWORD ?? '';
  if (password.length < 10 || password === 'radcore-demo') {
    throw new Error('SEED_DEMO_DATA needs DEMO_PASSWORD: your own password of at least 10 characters for the review sign-ins.');
  }
  await seedDemo(db, password);
  return 'loaded';
}

/** What the Online orders screen looks like once Shopify is connected and a marketplace report has been brought in. */
async function seedOnlineOrders(ctx: Ctx): Promise<void> {
  const shopify = (id: number, name: string, sku: string, title: string, price: string, who: [string, string, string], state: string) => ({
    id, name: `#${name}`, created_at: new Date().toISOString(), currency: 'INR', taxes_included: true, total_price: price, financial_status: 'paid',
    payment_gateway_names: ['razorpay'], customer: { first_name: who[0], last_name: who[1], phone: who[2] },
    shipping_address: { name: `${who[0]} ${who[1]}`, phone: who[2], address1: '14 Lake Road', city: state === 'KA' ? 'Bengaluru' : 'Pune', province_code: state, zip: state === 'KA' ? '560001' : '411001' },
    line_items: [{ sku, title, quantity: 1, price }], shipping_lines: [],
  });
  const good = shopify(900001, '1042', 'BRD-LONG', 'Longboard 42"', '9440.00', ['Rhea', 'Menon', '+919820055555'], 'KA');
  const stuck = shopify(900002, '1043', 'GRIP-TAPE', 'Grip tape', '499.00', ['Kabir', 'Sethi', '+919820066666'], 'MH');
  const amazon: OnlineOrder = {
    channel: 'amazon', externalId: '402-7781234-5567890', name: '402-7781234-5567890', orderDate: istDate(), currency: 'INR',
    customer: { name: 'Tanvi P', phone: null, email: null }, address: { line1: '', line2: '', city: 'Hyderabad', state: 'Telangana', pincode: '500001' },
    lines: [{ sku: 'HLM-01', title: 'Helmet', qty: '2', unitPrice: '1534.00', discount: '0.00' }], shipping: '0.00', taxInclusive: true, total: null,
    payment: 'unknown', paymentNote: 'Paid to Amazon, which settles with us', note: null,
  };
  const taken = await takeOrder(ctx, fromShopify(good));
  const fromAmazon = await takeOrder(ctx, amazon);
  await ctx.tx.insert(channelEvents).values([
    { channel: 'shopify', eventType: 'order', externalId: String(good.id), payload: good, status: 'processed', orderId: taken.orderId, summary: taken.summary, attempts: 1, processedAt: new Date() },
    { channel: 'amazon', eventType: 'order', externalId: amazon.externalId, payload: amazon, status: 'processed', orderId: fromAmazon.orderId, summary: fromAmazon.summary, attempts: 1, processedAt: new Date() },
    { channel: 'shopify', eventType: 'order', externalId: String(stuck.id), payload: stuck, status: 'failed', summary: 'Shopify #1043', attempts: 1,
      error: 'Shopify #1043: no item here has the SKU GRIP-TAPE (Grip tape). Add the item or correct its SKU, then try again.' },
  ]);
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

  // ---- a project with its tasks, and who is allocated where ----
  const [stall] = await tx.insert(projects).values([
    { projectNo: 'PRJ001', name: 'Diwali exhibition stall', description: 'Stall at the Pune sports expo: 40 display boards, banners and a demo corner.', ownerId: user('sales'), startDate: addDays(today, -6), deadline: addDays(today, 24), status: 'active' },
    { projectNo: 'PRJ002', name: 'New product photos for the website', ownerId: user('marketing'), startDate: addDays(today, 5), deadline: addDays(today, 35), status: 'planned' },
  ]).returning({ id: projects.id });
  await tx.execute(sql`insert into number_series (doc_type, fy, prefix, next_value) values ('project', 'ALL', 'PRJ', 3)`);
  await tx.insert(tasks).values([
    { projectId: stall!.id, title: 'Book the stall and pay the deposit', assigneeId: user('sales'), startDate: addDays(today, -6), dueDate: addDays(today, -3), status: 'done', completedAt: new Date(`${addDays(today, -4)}T09:00:00Z`), completedBy: user('sales') },
    { projectId: stall!.id, title: 'Order banners and standees', assigneeId: user('marketing'), startDate: addDays(today, -4), dueDate: addDays(today, -1), checklist: [{ text: 'Artwork approved', done: true }, { text: 'Printer paid', done: false }] },
    { projectId: stall!.id, title: 'Build 40 display boards', assigneeId: user('stores'), startDate: addDays(today, -2), dueDate: addDays(today, 14), dueTime: '18:00' },
    { projectId: stall!.id, title: 'Arrange the transport', assigneeId: user('operations'), dueDate: addDays(today, 20) },
    { projectId: stall!.id, title: 'Set up the stall', assigneeId: user('store'), startDate: addDays(today, 22), dueDate: addDays(today, 24), dueTime: '09:00' },
  ]);
  const [sunita, amit, ganesh] = people;
  await tx.insert(allocations).values([
    { projectId: stall!.id, employeeId: ganesh!.id, fromDate: addDays(today, -2), toDate: addDays(today, 14), percent: 60, role: 'Building the display boards' },
    { label: 'Stores and dispatch', employeeId: ganesh!.id, fromDate: addDays(today, -2), toDate: addDays(today, 30), percent: 40 },
    { projectId: stall!.id, employeeId: amit!.id, fromDate: addDays(today, -6), toDate: addDays(today, 24), percent: 30, role: 'Runs the project' },
    { label: 'Dealer visits', employeeId: amit!.id, fromDate: addDays(today, 0), toDate: addDays(today, 40), percent: 70 },
    { projectId: stall!.id, employeeId: sunita!.id, fromDate: addDays(today, 22), toDate: addDays(today, 24), percent: 100, role: 'Sets up and runs the stall' },
    { label: 'Showroom', employeeId: sunita!.id, fromDate: addDays(today, -6), toDate: addDays(today, 40), percent: 100 },
    { projectId: stall!.id, assetId: router!.id, fromDate: addDays(today, -2), toDate: addDays(today, 14), percent: 100, role: 'Cutting the boards' },
    { projectId: stall!.id, assetId: van!.id, fromDate: addDays(today, 22), toDate: addDays(today, 24), percent: 100, role: 'Moving the stall' },
  ]);
  await tx.insert(maintenanceSchedules).values([
    { assetId: router!.id, title: 'Full service', intervalCount: 6, intervalUnit: 'months', lastDoneOn: addMonths(addDays(today, -4), -6), nextDueOn: addDays(today, -4), assigneeId: user('operations'), remindDaysBefore: 14, instructions: 'Call the vendor engineer. Check spindle bearings and rails.' },
    { assetId: van!.id, title: 'Insurance renewal', intervalCount: 12, intervalUnit: 'months', nextDueOn: addDays(today, 9), assigneeId: user('accounts'), remindDaysBefore: 30 },
    { assetId: van!.id, title: 'Service and oil change', intervalCount: 4, intervalUnit: 'months', lastDoneOn: addMonths(today, -1), nextDueOn: addMonths(today, 3), assigneeId: user('operations'), remindDaysBefore: 10 },
  ]);
}
