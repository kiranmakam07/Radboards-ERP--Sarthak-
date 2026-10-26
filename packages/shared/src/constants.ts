/**
 * Fixed vocabularies and state machines (PRD section 5 and 6). No free-text status anywhere:
 * every stage, status and kind a record can have is listed here, the database enums are built
 * from these lists (apps/api/src/db/schema.ts), and the screens show them through `label`.
 *
 * Adding a value: add it at the END of its list (a database enum only ever grows), then run
 * `npx drizzle-kit generate --name <what changed>` in apps/api to make the migration.
 *
 * The permission table (PERMISSIONS) is at the bottom of this file.
 */

// New roles are added at the end: the database enum only ever grows, and the order is relied on by the demo logins.
export const ROLES = ['owner', 'marketing', 'store', 'sales', 'stores', 'accounts', 'admin', 'hr', 'operations', 'technician', 'service_manager'] as const;
export type Role = (typeof ROLES)[number];

// A franchisee buys from us like a dealer does (the dealer price list, credit terms), under its own name.
// New kinds are added at the end: the database enums only ever grow.
export const PARTY_TYPES = ['customer', 'dealer', 'supplier', 'franchisee'] as const;
export type PartyType = (typeof PARTY_TYPES)[number];
/** Who we sell to. */
export const SELLING_PARTY_TYPES = ['customer', 'dealer', 'franchisee'] as const satisfies readonly PartyType[];
/** Who buys at the dealer price (trade) rather than retail. */
export const TRADE_PARTY_TYPES = ['dealer', 'franchisee'] as const satisfies readonly PartyType[];
export const isTradeParty = (t: string | null | undefined): boolean => (TRADE_PARTY_TYPES as readonly string[]).includes(t ?? '');

// EV kinds: a vehicle is built from sub-assemblies (battery pack, controller, motor); accessories are
// sold alongside; consumables are used up in the workshop.
export const ITEM_TYPES = ['raw_material', 'finished_good', 'spare_part', 'service', 'vehicle', 'sub_assembly', 'accessory', 'consumable'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

// 'job_work' is where our material lies while an outside worker has it: still ours, not on our shelves.
// 'service_bay' is the workshop, 'demo' the test-ride and display units, 'franchise' stock kept at a
// franchisee's store that is still ours, 'in_transit' goods on the road between two of our places.
// Only stores and showroom count as stock that can be sold today.
export const LOCATION_TYPES = ['stores', 'showroom', 'rejected', 'job_work', 'service_bay', 'demo', 'franchise', 'in_transit'] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];
/** Places goods cannot be delivered to a customer from (job work has its own rule: only its challan moves that stock). */
export const UNSELLABLE_LOCATION_TYPES = ['rejected', 'service_bay', 'in_transit'] as const satisfies readonly LocationType[];

// The vehicle stages (brief P2) sit between meeting_booked and converted: a test ride booked and done, a
// quote, a booking (an order with an advance and the scooter held by serial), and the vehicle delivered.
export const LEAD_STAGES = [
  'new', 'contacted', 'interested', 'meeting_booked', 'test_ride_booked', 'test_ride_done', 'quoted', 'booked', 'delivered', 'converted', 'lost',
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];
export const OPEN_LEAD_STAGES: LeadStage[] = ['new', 'contacted', 'interested', 'meeting_booked', 'test_ride_booked', 'test_ride_done', 'quoted', 'booked'];
/** Stages where next_follow_up_at is mandatory (PRD 7.3). */
export const FOLLOW_UP_REQUIRED_STAGES: LeadStage[] = ['contacted', 'interested', 'meeting_booked', 'quoted'];
/** Stages a lead reaches only through what happens (a test ride booked or done, a booking, a delivery), never by a move. */
export const EVENT_LEAD_STAGES: LeadStage[] = ['test_ride_booked', 'test_ride_done', 'booked', 'delivered'];

export const LEAD_STAGE_LABELS: Record<LeadStage, string> = {
  new: 'New',
  contacted: 'Contacted',
  interested: 'Interested',
  meeting_booked: 'Meeting Booked',
  test_ride_booked: 'Test Ride Booked',
  test_ride_done: 'Test Ride Done',
  quoted: 'Quoted',
  booked: 'Booked',
  delivered: 'Delivered',
  converted: 'Converted',
  lost: 'Lost',
};

/**
 * Lead stage machine, for moves made by hand. `converted` is only reachable through the convert action
 * (which creates the party); the event stages (EVENT_LEAD_STAGES) only by what happens; `lost` can be
 * reopened to `contacted`. A booked lead can still be lost (the booking cancelled) or converted.
 */
const BY_HAND: LeadStage[] = ['contacted', 'interested', 'meeting_booked', 'quoted', 'converted', 'lost'];
export const LEAD_TRANSITIONS: Record<LeadStage, LeadStage[]> = {
  new: BY_HAND,
  contacted: BY_HAND.filter((s) => s !== 'contacted'),
  interested: BY_HAND.filter((s) => s !== 'interested'),
  meeting_booked: BY_HAND.filter((s) => s !== 'meeting_booked'),
  test_ride_booked: BY_HAND,
  test_ride_done: BY_HAND,
  quoted: BY_HAND.filter((s) => s !== 'quoted'),
  booked: ['converted', 'lost'],
  delivered: ['converted'],
  converted: [],
  lost: ['contacted'],
};

/** A test ride on a demo unit: booked for a slot, then done, not turned up, or cancelled. */
export const TEST_RIDE_OUTCOMES = ['booked', 'done', 'no_show', 'cancelled'] as const;
export type TestRideOutcome = (typeof TEST_RIDE_OUTCOMES)[number];

export function canMoveLead(from: LeadStage, to: LeadStage): boolean {
  return LEAD_TRANSITIONS[from].includes(to);
}

export const LEAD_ACTIVITY_TYPES = ['call', 'whatsapp', 'meeting', 'note', 'enquiry', 'stage_change'] as const;
export type LeadActivityType = (typeof LEAD_ACTIVITY_TYPES)[number];

// 'service': the bill for chargeable work on a job card (modules/service.ts).
export const CHANNELS = ['store', 'dealer', 'shopify', 'amazon', 'flipkart', 'website', 'service'] as const;
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
  'opening', 'purchase_in', 'sale_out', 'sales_return_in', 'purchase_return_out', 'transfer', 'adjustment', 'job_work',
  // Parts fitted on a job card, from the workshop shelf (modules/service.ts).
  'service_issue',
  // A change of value with no change of quantity: landed cost added to goods already received (modules/imports.ts).
  'revaluation',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const ADJUSTMENT_STATUSES = ['pending', 'approved', 'rejected'] as const;

// ---------------------------------------------------------------------------
// Service and warranty: job cards for units in the workshop (modules/service.ts)
// ---------------------------------------------------------------------------
/** open -> diagnosed -> estimate_sent -> approved -> in_progress -> ready -> delivered, or cancelled. */
export const JOB_CARD_STATUSES = ['open', 'diagnosed', 'estimate_sent', 'approved', 'in_progress', 'ready', 'delivered', 'cancelled'] as const;
export type JobCardStatus = (typeof JOB_CARD_STATUSES)[number];
export const JOB_CARD_STATUS_LABELS: Record<JobCardStatus, string> = {
  open: 'Open', diagnosed: 'Diagnosed', estimate_sent: 'Estimate sent', approved: 'Approved', in_progress: 'In progress',
  ready: 'Ready', delivered: 'Delivered', cancelled: 'Cancelled',
};
/**
 * The order the brief gives, plus two ways back: an estimate changed after it was sent, and more work found
 * after approval, both go back to diagnosed so that the customer approves again. Work with nothing
 * chargeable (all under warranty) needs no estimate. Delivery is its own step: it makes the bill.
 */
export const JOB_CARD_TRANSITIONS: Record<JobCardStatus, readonly JobCardStatus[]> = {
  open: ['diagnosed', 'cancelled'],
  diagnosed: ['estimate_sent', 'approved', 'cancelled'],
  estimate_sent: ['approved', 'diagnosed', 'cancelled'],
  approved: ['in_progress', 'diagnosed', 'cancelled'],
  in_progress: ['ready', 'diagnosed', 'cancelled'],
  ready: ['delivered'],
  delivered: [],
  cancelled: [],
};
export const canMoveJobCard = (from: JobCardStatus, to: JobCardStatus) => JOB_CARD_TRANSITIONS[from].includes(to);
export const JOB_LINE_KINDS = ['part', 'labour'] as const;
export const CLAIM_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'credited'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
/** draft -> sent -> accepted / rejected; accepted -> credited. */
export const CLAIM_TRANSITIONS: Record<ClaimStatus, readonly ClaimStatus[]> = {
  draft: ['sent'], sent: ['accepted', 'rejected'], accepted: ['credited'], rejected: [], credited: [],
};

// ---------------------------------------------------------------------------
// Imports: shipments from abroad and their landed cost (modules/imports.ts)
// ---------------------------------------------------------------------------
export const IMPORT_STAGES = ['pi', 'advance_paid', 'production', 'shipped', 'at_port', 'boe_filed', 'cleared', 'received'] as const;
export type ImportStage = (typeof IMPORT_STAGES)[number];
export const IMPORT_STAGE_LABELS: Record<ImportStage, string> = {
  pi: 'Proforma invoice', advance_paid: 'Advance paid', production: 'In production', shipped: 'Shipped', at_port: 'At port',
  boe_filed: 'Bill of entry filed', cleared: 'Cleared customs', received: 'Received',
};
/** bcd: basic customs duty; sws: social welfare surcharge; igst: IGST paid at customs, input credit and never cost; cha: customs agent. */
export const LANDED_COST_KINDS = ['freight', 'insurance', 'bcd', 'sws', 'igst', 'cha', 'port', 'inland', 'other'] as const;
export type LandedCostKind = (typeof LANDED_COST_KINDS)[number];
/** How a cost is spread over the shipment's goods: by their value, their quantity or their weight. */
export const LANDED_COST_BASES = ['value', 'qty', 'weight'] as const;
export type LandedCostBasis = (typeof LANDED_COST_BASES)[number];

/**
 * Where one serialised unit (a vehicle, a battery pack, a motor) stands. available, demo and reserved
 * are on our shelves; under_repair, quarantine and damaged are ours but not for sale; rtv went back
 * to the supplier, sold to a customer, scrapped is written off.
 */
export const UNIT_STATUSES = ['available', 'reserved', 'demo', 'under_repair', 'quarantine', 'damaged', 'rtv', 'sold', 'scrapped'] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];
/** A reservation holds stock for one order: open until delivered (fulfilled), let go (released) or past its date (expired). */
export const RESERVATION_STATUSES = ['open', 'fulfilled', 'released', 'expired'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** The statuses a unit can be sold from. */
export const SELLABLE_UNIT_STATUSES = ['available', 'demo'] as const satisfies readonly UnitStatus[];

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

// ---------------------------------------------------------------------------
// Operations (PRD 7.14, Tier 3): recurring tasks with checklists, assets and their maintenance
// ---------------------------------------------------------------------------
export const TASK_FREQUENCIES = ['daily', 'weekly', 'monthly', 'need_based'] as const;
export type TaskFrequency = (typeof TASK_FREQUENCIES)[number];
export const TASK_STATUSES = ['open', 'done', 'skipped'] as const;
/**
 * The columns of the task board. An open task is "todo" until someone starts it ("in_progress");
 * the other two are the closed statuses. Worked out from status and started_at, never stored.
 */
export const TASK_STAGES = ['todo', 'in_progress', 'done', 'skipped'] as const;
export type TaskStage = (typeof TASK_STAGES)[number];
export const TASK_STAGE_LABELS: Record<TaskStage, string> = {
  todo: 'To do', in_progress: 'In progress', done: 'Done', skipped: 'Could not do',
};
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  planned: 'Planned', active: 'Active', on_hold: 'On hold', done: 'Done', cancelled: 'Cancelled',
};
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
  // Masters: the set-up records every other screen reads from (items, customers and suppliers, employees,
  // and the small lists). They are changed in one place, by an admin, and the change shows everywhere.
  'masters:manage': ['admin'],
  'audit:read': ['admin', 'owner'],

  'items:read': ['owner', 'marketing', 'store', 'sales', 'stores', 'accounts', 'admin', 'technician', 'service_manager'],
  // What stock cost us (purchase cost, average cost, stock value, margins). Everyone else sees selling prices only.
  'costs:read': ['owner', 'stores', 'accounts', 'admin'],
  'items:write': ['admin'],
  'pricelists:write': ['admin'],
  'pricelists:approve': ['owner', 'admin'],

  'parties:read': ['owner', 'marketing', 'store', 'sales', 'stores', 'accounts', 'admin', 'technician', 'service_manager'],
  // Adding a new customer or supplier in the middle of the work (a walk-in at the counter, a new supplier on a bill).
  'parties:write': ['store', 'sales', 'stores', 'accounts', 'admin'],
  // Changing one afterwards, and its price list, credit limit and payment terms.
  'parties:manage': ['admin'],
  // Adding and changing employees: their details, salary, deductions, bank account and sign-in.
  'employees:manage': ['admin'],

  'leads:read': ['owner', 'marketing', 'store', 'sales', 'admin'],
  'leads:write': ['marketing', 'store', 'sales', 'admin'],
  // Lead sources, their connections (Meta, Google, WhatsApp, website) and the quick-reply messages.
  'crm:manage': ['marketing', 'admin'],

  'sales:read': ['owner', 'store', 'sales', 'accounts', 'admin'],
  'sales:write': ['store', 'sales', 'accounts', 'admin'],
  'sales:override_credit': ['owner', 'accounts', 'admin'],
  // Selling below cost, or at a bigger discount than the seller's own limit (settings: discount_limits).
  'sales:approve_discount': ['owner', 'accounts', 'admin'],
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
  // Serialised units: looking them up (the counter and sales pick serials when they sell), and describing
  // them (fitting a component, a battery's BPAN, firmware, its storage charge).
  'units:read': ['owner', 'store', 'sales', 'stores', 'accounts', 'operations', 'admin', 'technician', 'service_manager'],
  'units:write': ['stores', 'operations', 'admin'],
  // Job work: material sent to an outside worker on a challan, and what comes back.
  'jobwork:read': ['owner', 'stores', 'accounts', 'operations', 'admin'],
  'jobwork:write': ['stores', 'operations', 'admin'],

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
  // Salaries: who may see what people are paid, and who may run the month's salary.
  'payroll:read': ['owner', 'accounts', 'hr', 'admin'],
  'payroll:manage': ['accounts', 'hr', 'admin'],

  // Operations: everyone can see and finish the tasks given to them; these are for running the whole board.
  'ops:read': ['owner', 'operations', 'admin'],
  'ops:manage': ['operations', 'admin'],

  // Service and warranty. The technician works the job cards (and never sees cost price); the service
  // manager also sets the warranty rules and fault codes, changes what is under warranty, and handles
  // the claims made on suppliers.
  'service:read': ['owner', 'stores', 'accounts', 'technician', 'service_manager', 'admin'],
  'service:write': ['technician', 'service_manager', 'admin'],
  'service:approve': ['owner', 'service_manager', 'admin'],

  // Imports: shipments and their landed cost. Booking costs paid and putting them on the goods is for Accounts.
  'imports:read': ['owner', 'stores', 'accounts', 'admin'],
  'imports:write': ['stores', 'accounts', 'admin'],
  'imports:post': ['accounts', 'admin'],
} as const satisfies Record<string, readonly Role[]>;

// A new permission is one line in the table above, named in a route with requirePerm('area:action')
// and in the menu (apps/web/app/(app)/layout.tsx) when a screen depends on it.
export type Permission = keyof typeof PERMISSIONS;
export type PermissionOverrides = Partial<Record<Permission, readonly Role[]>>;

// The table above is the starting point. An admin can change who holds a permission on the
// Permissions screen; those changes are kept in the database and applied here when the API starts
// and whenever one is saved.
let overrides: PermissionOverrides = {};

/** Replace the admin's changes to the matrix. Pass {} to go back to the defaults. */
export function setPermissionOverrides(next: PermissionOverrides): void {
  overrides = { ...next };
}

/** The roles that hold a permission right now (admin always does, whatever this says). */
export function rolesFor(permission: Permission): readonly Role[] {
  return overrides[permission] ?? PERMISSIONS[permission];
}

export function can(role: Role, permission: Permission): boolean {
  if (role === 'admin') return true;
  return rolesFor(permission).includes(role);
}
