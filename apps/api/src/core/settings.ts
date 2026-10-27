import { eq } from 'drizzle-orm';
import { PAYROLL_RULES_DEFAULT, PERMISSIONS, ROLES, setPermissionOverrides, type PayrollRules, type Permission, type PermissionOverrides, type Role } from '@radcore/shared';
import type { DB } from '../db/client';
import { entities, settings } from '../db/schema';
import { badRequest } from '../lib/errors';

/**
 * Settings: the few things an admin changes on screen (company profile, period lock, the rules
 * for attendance and payroll, who holds which permission), and some small pieces of state the
 * system keeps for itself. One row per key in the `settings` table. SettingsMap gives each key
 * its type and SETTING_DEFAULTS what it is until someone sets it, so adding a setting is two lines
 * here and no migration.
 */

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
  /** Changes an admin has made to who holds which permission: { 'hr:read': ['owner', 'hr', 'accounts'] }. */
  permission_overrides: Record<string, string[]>;
  /** Leave days a year for anyone without their own figure. */
  annual_leave_days: number;
  /** True when this database was filled with sample data (the demo, or a review copy). Shown as a banner. */
  sample_data: boolean;
  /**
   * How attendance is judged: when the day starts and how many minutes of grace before someone is
   * late, which weekdays are the weekly off (0 = Sunday), and where the workplace is, so that a
   * clock-in from somewhere else can be seen.
   */
  attendance_rules: { start: string | null; grace_min: number; weekly_off: number[]; place: { name: string; lat: number; lng: number; radius_m: number } | null };
  /** The figures salaries are worked out with (see computePay in the shared package). */
  payroll_rules: PayrollRules;
  /** When the statements mailbox was last read, how many new mails that found, and what went wrong if it could not be read. */
  bank_mail_state: { last_checked_at: string | null; last_found: number; last_error: string | null };
  /** When the background jobs last ran (core/jobs.ts), and what each did. */
  jobs_state: { last_run_at: string | null; result: Record<string, string> };
  /** When Meta last confirmed our webhook addresses (its one-time check when a webhook is subscribed). */
  crm_state: { meta_verified_at: string | null; whatsapp_verified_at: string | null };
  /**
   * The biggest discount off the price list, in %, each role may give without approval
   * ({ store: 5, sales: 10 }). A role not named here may give none, unless it holds
   * sales:approve_discount (no limit). Selling below purchase cost always needs that permission.
   */
  discount_limits: Partial<Record<Role, number>>;
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
  permission_overrides: {},
  annual_leave_days: 12,
  sample_data: false,
  attendance_rules: { start: null, grace_min: 10, weekly_off: [0], place: null },
  payroll_rules: PAYROLL_RULES_DEFAULT,
  bank_mail_state: { last_checked_at: null, last_found: 0, last_error: null },
  jobs_state: { last_run_at: null, result: {} },
  discount_limits: { store: 5, sales: 10 },
  crm_state: { meta_verified_at: null, whatsapp_verified_at: null },
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
  // The company profile is the first (default) legal entity: keep the two the same.
  if (key === 'company') {
    const c = value as CompanyProfile;
    await tx.update(entities).set({
      legalName: c.legal_name || c.name, gstin: c.gstin ?? null, stateCode: c.state_code, address: c.address ?? {}, updatedAt: new Date(),
    }).where(eq(entities.isDefault, true));
  }
}

/** Apply the admin's saved permission changes. Called when the API starts and after each change. */
export async function loadPermissionOverrides(tx: DB): Promise<void> {
  const saved = await getSetting(tx, 'permission_overrides');
  const valid: PermissionOverrides = {};
  for (const [key, roles] of Object.entries(saved ?? {})) {
    // Ignore anything that no longer exists, so an old entry cannot break sign-in after an upgrade.
    if (key in PERMISSIONS && Array.isArray(roles)) valid[key as Permission] = roles.filter((r): r is Role => (ROLES as readonly string[]).includes(r));
  }
  setPermissionOverrides(valid);
}

/**
 * The company a document is issued by: the profile on the Setup screen, or for a document of another
 * legal entity, that entity's name, GSTIN, state and address (bank details and terms stay the profile's).
 */
export async function getCompany(tx: DB, entityId?: string | null): Promise<CompanyProfile> {
  const company = await getSetting(tx, 'company');
  if (entityId) {
    const [e] = await tx.select().from(entities).where(eq(entities.id, entityId));
    if (e && !e.isDefault) {
      return { ...company, name: e.legalName, legal_name: e.legalName, gstin: e.gstin, state_code: e.stateCode, address: (e.address ?? {}) as CompanyProfile['address'] };
    }
  }
  if (!company.state_code) throw badRequest('Company state is not set. Ask an admin to fill in the company profile.');
  return company;
}

/** The first legal entity, the one everything belongs to unless it names another. */
export async function defaultEntityId(tx: DB): Promise<string> {
  const [e] = await tx.select({ id: entities.id }).from(entities).where(eq(entities.isDefault, true));
  if (!e) throw new Error('The default legal entity is missing');
  return e.id;
}
