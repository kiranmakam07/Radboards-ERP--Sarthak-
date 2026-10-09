// Fixed vocabularies and state machines (PRD section 5 and 6). No free-text status anywhere.

// New roles are added at the end: the database enum only ever grows, and the order is relied on by the demo logins.
export const ROLES = ['owner', 'marketing', 'store', 'sales', 'stores', 'accounts', 'admin', 'hr', 'operations'] as const;
export type Role = (typeof ROLES)[number];

export const PARTY_TYPES = ['customer', 'dealer', 'supplier'] as const;
export type PartyType = (typeof PARTY_TYPES)[number];

export const ITEM_TYPES = ['raw_material', 'finished_good', 'spare_part', 'service'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const LOCATION_TYPES = ['stores', 'showroom', 'rejected'] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const LEAD_STAGES = ['new', 'contacted', 'interested', 'meeting_booked', 'converted', 'lost'] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];
export const OPEN_LEAD_STAGES: LeadStage[] = ['new', 'contacted', 'interested', 'meeting_booked'];
/** Stages where next_follow_up_at is mandatory (PRD 7.3). */
export const FOLLOW_UP_REQUIRED_STAGES: LeadStage[] = ['contacted', 'interested', 'meeting_booked'];

export const LEAD_STAGE_LABELS: Record<LeadStage, string> = {
  new: 'New',
  contacted: 'Contacted',
  interested: 'Interested',
  meeting_booked: 'Meeting Booked',
  converted: 'Converted',
  lost: 'Lost',
};

/**
 * Lead stage machine. `converted` is only reachable through the convert action
 * (which creates the party); `lost` can be reopened to `contacted`.
 */
export const LEAD_TRANSITIONS: Record<LeadStage, LeadStage[]> = {
  new: ['contacted', 'interested', 'meeting_booked', 'converted', 'lost'],
  contacted: ['interested', 'meeting_booked', 'converted', 'lost'],
  interested: ['contacted', 'meeting_booked', 'converted', 'lost'],
  meeting_booked: ['contacted', 'interested', 'converted', 'lost'],
  converted: [],
  lost: ['contacted'],
};

export function canMoveLead(from: LeadStage, to: LeadStage): boolean {
  return LEAD_TRANSITIONS[from].includes(to);
}

export const LEAD_ACTIVITY_TYPES = ['call', 'whatsapp', 'meeting', 'note', 'enquiry', 'stage_change'] as const;
export type LeadActivityType = (typeof LEAD_ACTIVITY_TYPES)[number];

export const CHANNELS = ['store', 'dealer', 'shopify', 'amazon', 'flipkart', 'website'] as const;
export type Channel = (typeof CHANNELS)[number];

export const ORDER_STATUSES = ['draft', 'confirmed', 'delivered', 'invoiced', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const INVOICE_DOC_TYPES = ['tax_invoice', 'credit_note'] as const;
export const INVOICE_STATUSES = ['draft', 'issued', 'cancelled'] as const;

export const PAYMENT_MODES = ['cash', 'upi', 'bank_transfer', 'card', 'cheque'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];
export const PAYMENT_DIRECTIONS = ['in', 'out'] as const;

export const PO_STATUSES = ['draft', 'sent', 'partly_received', 'received', 'closed', 'cancelled'] as const;
export const GRN_STATUSES = ['received', 'inwarded', 'cancelled'] as const;
export const BILL_DOC_TYPES = ['bill', 'debit_note'] as const;
export const BILL_STATUSES = ['posted', 'cancelled'] as const;

export const MOVEMENT_TYPES = [
  'opening', 'purchase_in', 'sale_out', 'sales_return_in', 'purchase_return_out', 'transfer', 'adjustment',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const ADJUSTMENT_STATUSES = ['pending', 'approved', 'rejected'] as const;

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const UNITS = ['Nos', 'Pcs', 'Set', 'Kg', 'Gm', 'Mtr', 'Ltr', 'Box', 'Pair', 'Roll', 'Sheet'] as const;

// ---------------------------------------------------------------------------
// HR (PRD 7.14, Tier 2): applicants -> interview stages -> hired (creates an employee) or rejected
// ---------------------------------------------------------------------------
export const APPLICANT_STAGES = ['applied', 'shortlisted', 'interview', 'offered', 'hired', 'rejected'] as const;
export type ApplicantStage = (typeof APPLICANT_STAGES)[number];
export const OPEN_APPLICANT_STAGES: ApplicantStage[] = ['applied', 'shortlisted', 'interview', 'offered'];

export const APPLICANT_STAGE_LABELS: Record<ApplicantStage, string> = {
  applied: 'Applied',
  shortlisted: 'Shortlisted',
  interview: 'Interview',
  offered: 'Offered',
  hired: 'Hired',
  rejected: 'Rejected',
};

/**
 * Applicant stage machine. `hired` is only reachable through the hire action (which creates
 * the employee) and only from `offered`; a rejected applicant can be reopened to `shortlisted`.
 */
export const APPLICANT_TRANSITIONS: Record<ApplicantStage, ApplicantStage[]> = {
  applied: ['shortlisted', 'interview', 'rejected'],
  shortlisted: ['interview', 'offered', 'rejected'],
  interview: ['offered', 'rejected'],
  offered: ['hired', 'rejected'],
  hired: [],
  rejected: ['shortlisted'],
};

export function canMoveApplicant(from: ApplicantStage, to: ApplicantStage): boolean {
  return APPLICANT_TRANSITIONS[from].includes(to);
}

export const APPLICANT_SOURCES = ['job_portal', 'referral', 'walk_in', 'website', 'social_media', 'consultant', 'campus', 'other'] as const;
export type ApplicantSource = (typeof APPLICANT_SOURCES)[number];

export const REJECT_REASONS = [
  'not_qualified', 'failed_interview', 'salary_mismatch', 'declined_offer', 'no_show', 'position_filled', 'other',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const APPLICANT_ACTIVITY_TYPES = ['note', 'call', 'stage_change', 'interview'] as const;

export const OPENING_STATUSES = ['open', 'on_hold', 'closed'] as const;
export const INTERVIEW_MODES = ['in_person', 'phone', 'video'] as const;
export const INTERVIEW_STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'] as const;
export const INTERVIEW_RESULTS = ['pass', 'hold', 'fail'] as const;

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern'] as const;
export const EMPLOYEE_STATUSES = ['active', 'left'] as const;

export const ATTENDANCE_STATUSES = ['present', 'half_day', 'absent', 'leave', 'weekly_off', 'holiday'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
/** How much of a working day each status counts for. */
export const ATTENDANCE_DAY_VALUE: Record<AttendanceStatus, number> = {
  present: 1, half_day: 0.5, absent: 0, leave: 0, weekly_off: 0, holiday: 0,
};

// ---------------------------------------------------------------------------
// Operations (PRD 7.14, Tier 3): recurring tasks with checklists, assets and their maintenance
// ---------------------------------------------------------------------------
export const TASK_FREQUENCIES = ['daily', 'weekly', 'monthly', 'need_based'] as const;
export type TaskFrequency = (typeof TASK_FREQUENCIES)[number];
export const TASK_STATUSES = ['open', 'done', 'skipped'] as const;
export const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export const PROJECT_STATUSES = ['planned', 'active', 'on_hold', 'done', 'cancelled'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const ASSET_STATUSES = ['in_use', 'under_repair', 'retired'] as const;
export const INTERVAL_UNITS = ['days', 'months'] as const;
export type IntervalUnit = (typeof INTERVAL_UNITS)[number];

// ---------------------------------------------------------------------------
// Permission matrix (PRD 7.13): module:action -> roles. Admin can do everything.
// ---------------------------------------------------------------------------
export const PERMISSIONS = {
  'users:manage': ['admin'],
  'settings:manage': ['admin'],
  'masters:manage': ['admin'],
  'audit:read': ['admin', 'owner'],

  'items:read': ['owner', 'marketing', 'store', 'sales', 'stores', 'accounts', 'admin'],
  'items:write': ['admin', 'accounts', 'stores'],
  'pricelists:write': ['admin'],
  'pricelists:approve': ['owner', 'admin'],

  'parties:read': ['owner', 'marketing', 'store', 'sales', 'stores', 'accounts', 'admin'],
  'parties:write': ['store', 'sales', 'stores', 'accounts', 'admin'],

  'leads:read': ['owner', 'marketing', 'store', 'sales', 'admin'],
  'leads:write': ['marketing', 'store', 'sales', 'admin'],
  // Lead sources, their connections (Meta, Google, WhatsApp, website) and the quick-reply messages.
  'crm:manage': ['marketing', 'admin'],

  'sales:read': ['owner', 'store', 'sales', 'accounts', 'admin'],
  'sales:write': ['store', 'sales', 'accounts', 'admin'],
  'sales:override_credit': ['owner', 'accounts', 'admin'],
  'quickbill:create': ['store', 'sales', 'accounts', 'admin'],
  'invoices:read': ['owner', 'store', 'sales', 'accounts', 'admin'],
  'invoices:adjust': ['accounts', 'admin'], // cancel, credit notes

  'purchasing:read': ['owner', 'stores', 'accounts', 'admin'],
  'po:write': ['stores', 'accounts', 'admin'],
  'grn:write': ['stores', 'admin'],
  'bills:write': ['accounts', 'admin'],

  'stock:read': ['owner', 'marketing', 'store', 'sales', 'stores', 'accounts', 'admin'],
  'stock:write': ['stores', 'admin'],
  'stock:approve': ['owner', 'admin'],

  'payments:read': ['owner', 'accounts', 'admin'],
  'payments:write': ['accounts', 'admin'],
  'expenses:read': ['owner', 'accounts', 'admin'],
  'expenses:write': ['accounts', 'admin'],

  'accounts:read': ['owner', 'accounts', 'admin'],
  'accounts:write': ['accounts', 'admin'],
  'gst:read': ['owner', 'accounts', 'admin'],

  'dashboard:sales': ['owner', 'sales', 'store', 'admin'],
  'dashboard:marketing': ['owner', 'marketing', 'admin'],
  'dashboard:accounts': ['owner', 'accounts', 'admin'],
  'dashboard:stores': ['owner', 'stores', 'admin'],
  'dashboard:owner': ['owner', 'admin'],

  // HR: applicants, interviews, employees, attendance. Salaries live here, so it is not open to everyone.
  'hr:read': ['owner', 'hr', 'admin'],
  'hr:write': ['hr', 'admin'],

  // Operations: everyone can see and finish the tasks given to them; these are for running the whole board.
  'ops:read': ['owner', 'operations', 'admin'],
  'ops:manage': ['operations', 'admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  if (role === 'admin') return true;
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
