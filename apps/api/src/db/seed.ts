import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import type { AccountType } from '@radcore/shared';
import { config } from '../config';
import { hashPassword } from '../core/auth';
import { SETTING_DEFAULTS } from '../core/settings';
import { createDb, type DB } from './client';
import {
  accounts, expenseCategories, leadSources, locations, lostReasons, messageTemplates, priceLists, settings, tdsRates, users,
} from './schema';

/**
 * What a new installation needs before anyone can use it: the chart of accounts, the stock places,
 * the usual lead sources and lost reasons, price lists, expense categories, TDS rates and a few
 * quick replies (seedDefaults), and one admin to sign in with when there is no user at all
 * (ensureAdmin). Everything here is "add if missing", so it is safe to run at every start and it
 * never overwrites what has since been changed on screen.
 *
 * To add an account the posting rules can use, add it to COA with a `key` and name that key in
 * SystemAccount (core/journal.ts).
 */

type Coa = { code: string; name: string; type: AccountType; key?: string; group?: boolean; subtype?: 'cash' | 'bank'; parent?: string };

/** Indian chart of accounts (PRD 7.8). Accounts with a `key` are used by the posting service. */
const COA: Coa[] = [
  { code: '1000', name: 'Assets', type: 'asset', group: true },
  { code: '1100', name: 'Cash in Hand', type: 'asset', key: 'cash', subtype: 'cash', parent: '1000' },
  { code: '1110', name: 'Bank Account', type: 'asset', key: 'bank', subtype: 'bank', parent: '1000' },
  { code: '1200', name: 'Debtors (Accounts Receivable)', type: 'asset', key: 'debtors', parent: '1000' },
  { code: '1300', name: 'Stock in Hand', type: 'asset', key: 'stock', parent: '1000' },
  { code: '1400', name: 'Input CGST', type: 'asset', key: 'input_cgst', parent: '1000' },
  { code: '1410', name: 'Input SGST', type: 'asset', key: 'input_sgst', parent: '1000' },
  { code: '1420', name: 'Input IGST', type: 'asset', key: 'input_igst', parent: '1000' },
  { code: '1500', name: 'Staff Advances', type: 'asset', key: 'staff_advances', parent: '1000' },
  { code: '1510', name: 'TDS Receivable', type: 'asset', key: 'tds_receivable', parent: '1000' },

  { code: '2000', name: 'Liabilities', type: 'liability', group: true },
  { code: '2100', name: 'Creditors (Accounts Payable)', type: 'liability', key: 'creditors', parent: '2000' },
  { code: '2200', name: 'Output CGST', type: 'liability', key: 'output_cgst', parent: '2000' },
  { code: '2210', name: 'Output SGST', type: 'liability', key: 'output_sgst', parent: '2000' },
  { code: '2220', name: 'Output IGST', type: 'liability', key: 'output_igst', parent: '2000' },
  { code: '2230', name: 'Output Cess', type: 'liability', key: 'output_cess', parent: '2000' },
  { code: '2300', name: 'Goods Received Not Billed', type: 'liability', key: 'grni', parent: '2000' },
  { code: '2310', name: 'Job Work Charges to be Billed', type: 'liability', key: 'job_work_accrued', parent: '2000' },
  // Import costs put on the goods meet the bills and duty that pay for them here.
  { code: '2320', name: 'Landed Costs Clearing', type: 'liability', key: 'landed_cost_clearing', parent: '2000' },
  { code: '2400', name: 'Salaries Payable', type: 'liability', key: 'salaries_payable', parent: '2000' },
  { code: '2410', name: 'PF Payable', type: 'liability', key: 'pf_payable', parent: '2000' },
  { code: '2420', name: 'ESIC Payable', type: 'liability', key: 'esic_payable', parent: '2000' },
  { code: '2430', name: 'Professional Tax Payable', type: 'liability', key: 'pt_payable', parent: '2000' },
  { code: '2440', name: 'TDS Payable (Salaries)', type: 'liability', key: 'tds_payable', parent: '2000' },
  { code: '2450', name: 'TDS Payable (Vendors)', type: 'liability', key: 'tds_payable_vendors', parent: '2000' },

  { code: '3000', name: 'Equity', type: 'equity', group: true },
  { code: '3100', name: "Owner's Capital", type: 'equity', key: 'capital', parent: '3000' },
  { code: '3200', name: 'Opening Balance Equity', type: 'equity', key: 'opening_equity', parent: '3000' },
  { code: '3300', name: 'Retained Earnings', type: 'equity', key: 'retained_earnings', parent: '3000' },

  { code: '4000', name: 'Income', type: 'income', group: true },
  { code: '4100', name: 'Sales', type: 'income', key: 'sales', parent: '4000' },
  { code: '4200', name: 'Other Income', type: 'income', key: 'other_income', parent: '4000' },

  { code: '5000', name: 'Expenses', type: 'expense', group: true },
  { code: '5100', name: 'Cost of Goods Sold', type: 'expense', key: 'cogs', parent: '5000' },
  { code: '5110', name: 'Purchases (Non-stock)', type: 'expense', key: 'purchases', parent: '5000' },
  { code: '5120', name: 'Stock Adjustment', type: 'expense', key: 'stock_adjustment', parent: '5000' },
  // Parts fitted free under warranty; what a supplier credits back on a claim comes off it.
  { code: '5130', name: 'Warranty Expense', type: 'expense', key: 'warranty_expense', parent: '5000' },
  { code: '5200', name: 'Rent', type: 'expense', parent: '5000' },
  { code: '5210', name: 'Salaries & Wages', type: 'expense', key: 'salaries', parent: '5000' },
  { code: '5220', name: 'Electricity & Utilities', type: 'expense', parent: '5000' },
  { code: '5230', name: 'Freight & Courier', type: 'expense', parent: '5000' },
  { code: '5240', name: 'Marketing & Advertising', type: 'expense', parent: '5000' },
  { code: '5250', name: 'Office Expenses', type: 'expense', parent: '5000' },
  { code: '5260', name: 'Repairs & Maintenance', type: 'expense', parent: '5000' },
  { code: '5270', name: 'Travel & Conveyance', type: 'expense', parent: '5000' },
  { code: '5280', name: 'Bank Charges', type: 'expense', parent: '5000' },
  { code: '5290', name: 'Miscellaneous Expenses', type: 'expense', parent: '5000' },
  { code: '5900', name: 'Round Off', type: 'expense', key: 'round_off', parent: '5000' },
  // A loss is a debit, a gain a credit: paying a foreign bill at a different rate than it was booked at.
  { code: '5910', name: 'Foreign Exchange Gain / Loss', type: 'expense', key: 'forex_gain_loss', parent: '5000' },
];

const EXPENSE_CATEGORIES: [string, string][] = [
  ['Rent', '5200'], ['Salaries & Wages', '5210'], ['Electricity & Utilities', '5220'], ['Freight & Courier', '5230'],
  ['Marketing & Advertising', '5240'], ['Office Expenses', '5250'], ['Repairs & Maintenance', '5260'],
  ['Travel & Conveyance', '5270'], ['Bank Charges', '5280'], ['Miscellaneous', '5290'],
];

const LEAD_SOURCES = [
  'Meta Ads', 'Google Ads', 'Instagram Collab', 'YouTube Collab', 'Offline Campaign', 'Walk-in', 'Dealer Referral',
  'Website', 'WhatsApp', 'Other',
];

/** Starter quick replies; the team edits these to its own words. */
const QUICK_REPLIES: [string, string][] = [
  ['First hello', 'Hi {first_name}, this is {my_name} from {company}. Thanks for your enquiry about {products}. When is a good time for a quick call?'],
  ['Follow-up', 'Hi {first_name}, {my_name} from {company} here. Just checking in on {products}. Do you have any questions I can help with?'],
  ['Visit the showroom', 'Hi {first_name}, you are welcome to visit our showroom to try {products} yourself. Shall I book a time for you?'],
];
const LOST_REASONS = ['Price', 'Bought elsewhere', 'Not reachable', 'Just browsing', 'Other'];

/**
 * The usual kinds of payment tax is held back from, at the rates in general use. From 1 April 2026
 * they sit in section 393 of the Income-tax Act, 2025; the earlier section is named beside each so
 * it can be recognised. Accounts can change a rate, add a kind, or fill in the return's code.
 */
const TDS_RATES: [string, string, string][] = [
  ['Contractor (individual or HUF)', 'Section 393(1); earlier 194C', '1'],
  ['Contractor (company or firm)', 'Section 393(1); earlier 194C', '2'],
  ['Professional fees', 'Section 393(1); earlier 194J', '10'],
  ['Technical services', 'Section 393(1); earlier 194J', '2'],
  ['Rent of land, building or furniture', 'Section 393(1); earlier 194I', '10'],
  ['Rent of plant or machinery', 'Section 393(1); earlier 194I', '2'],
  ['Commission or brokerage', 'Section 393(1); earlier 194H', '2'],
  ['Purchase of goods', 'Section 393(1); earlier 194Q', '0.1'],
];

/**
 * Idempotent: creates the masters the system cannot run without. Safe to run on every boot.
 * Never overwrites something an admin has since edited.
 */
export async function seedDefaults(db: DB): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
      await tx.insert(settings).values({ key, value: value as object }).onConflictDoNothing();
    }

    const idByCode: Record<string, string> = {};
    for (const a of COA) {
      await tx
        .insert(accounts)
        .values({
          code: a.code,
          name: a.name,
          type: a.type,
          isGroup: a.group ?? false,
          isSystem: Boolean(a.key) || Boolean(a.group),
          systemKey: a.key ?? null,
          subtype: a.subtype ?? null,
          parentId: a.parent ? (idByCode[a.parent] ?? null) : null,
        })
        .onConflictDoNothing();
      const [row] = await tx.select({ id: accounts.id, systemKey: accounts.systemKey }).from(accounts).where(eq(accounts.code, a.code));
      if (row) idByCode[a.code] = row.id;
      // An account that was there before it was given a job by the system (Salaries & Wages, once payroll came) gets its key now.
      if (row && a.key && !row.systemKey) await tx.update(accounts).set({ systemKey: a.key, isSystem: true }).where(eq(accounts.id, row.id));
    }

    for (const [name, code] of EXPENSE_CATEGORIES) {
      const accountId = idByCode[code];
      if (accountId) await tx.insert(expenseCategories).values({ name, accountId }).onConflictDoNothing();
    }

    await tx
      .insert(locations)
      .values([
        { name: 'Stores', type: 'stores' },
        { name: 'Showroom', type: 'showroom' },
        { name: 'Rejected', type: 'rejected' },
        { name: 'With job workers', type: 'job_work' },
      ])
      .onConflictDoNothing();

    await tx
      .insert(priceLists)
      .values([
        { name: 'Retail', basePrice: 'retail', taxInclusive: true },
        { name: 'Dealer', basePrice: 'dealer', taxInclusive: false },
      ])
      .onConflictDoNothing();

    await tx.insert(leadSources).values(LEAD_SOURCES.map((name) => ({ name }))).onConflictDoNothing();
    await tx.insert(lostReasons).values(LOST_REASONS.map((name) => ({ name }))).onConflictDoNothing();
    await tx.insert(tdsRates).values(TDS_RATES.map(([name, lawReference, rate]) => ({ name, lawReference, rate }))).onConflictDoNothing();
    await tx.insert(messageTemplates).values(QUICK_REPLIES.map(([name, body], i) => ({ name, body, sortOrder: i }))).onConflictDoNothing();
  });
}

/**
 * Creates the first admin if there are no users. The password comes from
 * SEED_ADMIN_PASSWORD, or a random one is generated and printed exactly once.
 */
export async function ensureAdmin(db: DB): Promise<{ phone: string; password: string } | null> {
  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length > 0) return null;
  const phone = process.env.SEED_ADMIN_PHONE ?? '+919999999999';
  const password = process.env.SEED_ADMIN_PASSWORD ?? crypto.randomBytes(9).toString('base64url');
  await db.insert(users).values({
    name: process.env.SEED_ADMIN_NAME ?? 'Admin',
    phone,
    email: process.env.SEED_ADMIN_EMAIL ?? null,
    passwordHash: await hashPassword(password),
    role: 'admin',
  });
  return { phone, password };
}

// CLI: `npm run db:seed`
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const handle = await createDb(config.databaseUrl, config.migrationsFolder);
  await seedDefaults(handle.db);
  const admin = await ensureAdmin(handle.db);
  if (admin) {
    console.log('\nFirst admin user created. Sign in and change the password:');
    console.log(`  phone:    ${admin.phone}`);
    console.log(`  password: ${admin.password}\n`);
  } else console.log('Defaults seeded (users already exist, admin untouched).');
  await handle.close();
}
