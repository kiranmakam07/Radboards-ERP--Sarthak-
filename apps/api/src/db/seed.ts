import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import type { AccountType } from '@radcore/shared';
import { config } from '../config';
import { hashPassword } from '../core/auth';
import { SETTING_DEFAULTS } from '../core/settings';
import { createDb, type DB } from './client';
import {
  accounts, expenseCategories, leadSources, locations, lostReasons, messageTemplates, priceLists, settings, users,
} from './schema';

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

  { code: '2000', name: 'Liabilities', type: 'liability', group: true },
  { code: '2100', name: 'Creditors (Accounts Payable)', type: 'liability', key: 'creditors', parent: '2000' },
  { code: '2200', name: 'Output CGST', type: 'liability', key: 'output_cgst', parent: '2000' },
  { code: '2210', name: 'Output SGST', type: 'liability', key: 'output_sgst', parent: '2000' },
  { code: '2220', name: 'Output IGST', type: 'liability', key: 'output_igst', parent: '2000' },
  { code: '2300', name: 'Goods Received Not Billed', type: 'liability', key: 'grni', parent: '2000' },

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
  { code: '5200', name: 'Rent', type: 'expense', parent: '5000' },
  { code: '5210', name: 'Salaries & Wages', type: 'expense', parent: '5000' },
  { code: '5220', name: 'Electricity & Utilities', type: 'expense', parent: '5000' },
  { code: '5230', name: 'Freight & Courier', type: 'expense', parent: '5000' },
  { code: '5240', name: 'Marketing & Advertising', type: 'expense', parent: '5000' },
  { code: '5250', name: 'Office Expenses', type: 'expense', parent: '5000' },
  { code: '5260', name: 'Repairs & Maintenance', type: 'expense', parent: '5000' },
  { code: '5270', name: 'Travel & Conveyance', type: 'expense', parent: '5000' },
  { code: '5280', name: 'Bank Charges', type: 'expense', parent: '5000' },
  { code: '5290', name: 'Miscellaneous Expenses', type: 'expense', parent: '5000' },
  { code: '5900', name: 'Round Off', type: 'expense', key: 'round_off', parent: '5000' },
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
      const [row] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.code, a.code));
      if (row) idByCode[a.code] = row.id;
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
