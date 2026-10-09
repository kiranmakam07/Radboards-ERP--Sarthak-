import { eq } from 'drizzle-orm';
import type { DB } from '../db/client';
import { settings } from '../db/schema';
import { badRequest } from '../lib/errors';

export type CompanyProfile = {
  name: string;
  legal_name?: string;
  gstin: string | null;
  state_code: string;
  address: { line1?: string; line2?: string; city?: string; state?: string; pincode?: string };
  phone?: string;
  email?: string;
  logo_url?: string;
  bank?: { account_name?: string; account_no?: string; ifsc?: string; bank_name?: string; upi_id?: string };
  invoice_terms?: string;
};

export type SettingsMap = {
  company: CompanyProfile;
  /** YYYY-MM-DD: nothing dated on or before this can be posted (PRD 7.8). */
  period_lock_date: string | null;
  /** Admin switch: allow stock to go negative (PRD 8.5). Off by default. */
  allow_negative_stock: boolean;
  /** moving_average today; FIFO is a decision for the CA (PRD 7.6). */
  valuation_method: 'moving_average';
  /** Days until first follow-up for a new lead when none is given. */
  default_follow_up_days: number;
  /** Pointer for round-robin lead assignment. */
  lead_round_robin_last: string | null;
  /** YYYY-MM-DD: recurring tasks have been created up to and including this day. */
  tasks_generated_through: string | null;
  /** True when this database was filled with sample data (the demo, or a review copy). Shown as a banner. */
  sample_data: boolean;
};

export const SETTING_DEFAULTS: SettingsMap = {
  company: {
    name: 'Radboards Pvt Ltd',
    gstin: null,
    state_code: '27',
    address: {},
  },
  period_lock_date: null,
  allow_negative_stock: false,
  valuation_method: 'moving_average',
  default_follow_up_days: 1,
  lead_round_robin_last: null,
  tasks_generated_through: null,
  sample_data: false,
};

export async function getSetting<K extends keyof SettingsMap>(tx: DB, key: K): Promise<SettingsMap[K]> {
  const [row] = await tx.select().from(settings).where(eq(settings.key, key));
  return row ? (row.value as SettingsMap[K]) : SETTING_DEFAULTS[key];
}

export async function setSetting<K extends keyof SettingsMap>(
  tx: DB,
  key: K,
  value: SettingsMap[K],
  updatedBy: string | null,
): Promise<void> {
  await tx
    .insert(settings)
    .values({ key, value: value as unknown as object, updatedBy })
    .onConflictDoUpdate({ target: settings.key, set: { value: value as unknown as object, updatedBy, updatedAt: new Date() } });
}

export async function getCompany(tx: DB): Promise<CompanyProfile> {
  const company = await getSetting(tx, 'company');
  if (!company.state_code) throw badRequest('Company state is not set. Ask an admin to fill in the company profile.');
  return company;
}
