import { sql } from 'drizzle-orm';
import {
  bigint, bigserial, boolean, char, check, customType, date, index, integer, jsonb, numeric, pgEnum, pgTable, smallint, text, time,
  timestamp, unique, uniqueIndex, uuid, type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  ACCOUNT_TYPES, ADJUSTMENT_STATUSES, APPLICANT_ACTIVITY_TYPES, APPLICANT_SOURCES, APPLICANT_STAGES, ASSET_STATUSES,
  ATTENDANCE_STATUSES, BILL_DOC_TYPES, BILL_STATUSES, CHANNELS, EMPLOYEE_STATUSES, EMPLOYMENT_TYPES, GRN_STATUSES,
  INTERVAL_UNITS, INTERVIEW_MODES, INTERVIEW_RESULTS, INTERVIEW_STATUSES, INVOICE_DOC_TYPES, INVOICE_STATUSES, ITEM_TYPES,
  LEAD_ACTIVITY_TYPES, LEAD_STAGES, LOCATION_TYPES, MOVEMENT_TYPES, OPENING_STATUSES, ORDER_STATUSES, PARTY_TYPES,
  PAYMENT_DIRECTIONS, PAYMENT_MODES, PO_STATUSES, PROJECT_STATUSES, REJECT_REASONS, ROLES, TASK_FREQUENCIES, TASK_STATUSES,
} from '@radcore/shared';

// Money is numeric(12,2) in INR, quantities numeric(12,3) (PRD section 8).
const money = (name: string) => numeric(name, { precision: 12, scale: 2 });
const qty = (name: string) => numeric(name, { precision: 12, scale: 3 });
const pct = (name: string) => numeric(name, { precision: 5, scale: 2 });
const ts = (name: string) => timestamp(name, { withTimezone: true });

// Every table carries these (PRD section 8).
const stamps = {
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
};

export const roleEnum = pgEnum('user_role', ROLES);
export const partyTypeEnum = pgEnum('party_type', PARTY_TYPES);
export const itemTypeEnum = pgEnum('item_type', ITEM_TYPES);
export const locationTypeEnum = pgEnum('location_type', LOCATION_TYPES);
export const leadStageEnum = pgEnum('lead_stage', LEAD_STAGES);
export const leadActivityTypeEnum = pgEnum('lead_activity_type', LEAD_ACTIVITY_TYPES);
export const channelEnum = pgEnum('sales_channel', CHANNELS);
export const orderStatusEnum = pgEnum('order_status', ORDER_STATUSES);
export const invoiceDocTypeEnum = pgEnum('invoice_doc_type', INVOICE_DOC_TYPES);
export const invoiceStatusEnum = pgEnum('invoice_status', INVOICE_STATUSES);
export const paymentModeEnum = pgEnum('payment_mode', PAYMENT_MODES);
export const paymentDirectionEnum = pgEnum('payment_direction', PAYMENT_DIRECTIONS);
export const postedStatusEnum = pgEnum('posted_status', ['posted', 'cancelled']);
export const poStatusEnum = pgEnum('po_status', PO_STATUSES);
export const grnStatusEnum = pgEnum('grn_status', GRN_STATUSES);
export const billDocTypeEnum = pgEnum('bill_doc_type', BILL_DOC_TYPES);
export const billStatusEnum = pgEnum('bill_status', BILL_STATUSES);
export const movementTypeEnum = pgEnum('movement_type', MOVEMENT_TYPES);
export const adjustmentStatusEnum = pgEnum('adjustment_status', ADJUSTMENT_STATUSES);
export const adjustmentKindEnum = pgEnum('adjustment_kind', ['adjustment', 'count', 'opening']);
export const accountTypeEnum = pgEnum('account_type', ACCOUNT_TYPES);
export const accountSubtypeEnum = pgEnum('account_subtype', ['cash', 'bank']);
export const eventStatusEnum = pgEnum('event_status', ['received', 'processed', 'failed', 'ignored']);

// ----------------------------------------------------------------------------
// 8.1 users + sessions
// ----------------------------------------------------------------------------
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  phone: text('phone').notNull().unique(),
  email: text('email').unique(),
  passwordHash: text('password_hash').notNull(),
  role: roleEnum('role').notNull(),
  active: boolean('active').notNull().default(true),
  ...stamps,
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  userId: uuid('user_id').notNull().references(() => users.id),
  expiresAt: ts('expires_at').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

// ----------------------------------------------------------------------------
// 8.11 settings, audit, numbering
// ----------------------------------------------------------------------------
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  entity: text('entity').notNull(),
  entityId: text('entity_id').notNull(),
  action: text('action').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  userId: uuid('user_id'),
  at: ts('at').notNull().defaultNow(),
}, (t) => [index('audit_entity_idx').on(t.entity, t.entityId)]);

export const numberSeries = pgTable('number_series', {
  id: uuid('id').primaryKey().defaultRandom(),
  docType: text('doc_type').notNull(),
  fy: text('fy').notNull(),
  prefix: text('prefix').notNull(),
  nextValue: integer('next_value').notNull().default(1),
  ...stamps,
}, (t) => [unique('number_series_doc_fy').on(t.docType, t.fy)]);

// ----------------------------------------------------------------------------
// Masters
// ----------------------------------------------------------------------------
export const leadSources = pgTable('lead_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  /** Source rule: leads from this source go to this user; otherwise round-robin. */
  defaultOwnerId: uuid('default_owner_id').references(() => users.id),
  active: boolean('active').notNull().default(true),
  ...stamps,
});

export const lostReasons = pgTable('lost_reasons', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  active: boolean('active').notNull().default(true),
  ...stamps,
});

export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  sourceId: uuid('source_id').notNull().references(() => leadSources.id),
  /** Public token used in the QR / short link / website form (PRD 7.1). */
  token: text('token').notNull().unique(),
  active: boolean('active').notNull().default(true),
  ...stamps,
});

export const itemCategories = pgTable('item_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  parentId: uuid('parent_id').references((): AnyPgColumn => itemCategories.id),
  active: boolean('active').notNull().default(true),
  ...stamps,
});

export const locations = pgTable('locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  type: locationTypeEnum('type').notNull(),
  active: boolean('active').notNull().default(true),
  ...stamps,
});

export const priceLists = pgTable('price_lists', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  /** Which item price is used when the list has no override row: 'retail' or 'dealer'. */
  basePrice: text('base_price').notNull().default('retail'),
  /** Retail/MRP prices include GST; dealer prices are usually exclusive. */
  taxInclusive: boolean('tax_inclusive').notNull().default(false),
  approvedBy: uuid('approved_by').references(() => users.id),
  approvedAt: ts('approved_at'),
  active: boolean('active').notNull().default(true),
  ...stamps,
}, (t) => [check('price_lists_base_price_chk', sql`${t.basePrice} in ('retail','dealer')`)]);

// ----------------------------------------------------------------------------
// Chart of accounts
// ----------------------------------------------------------------------------
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  type: accountTypeEnum('type').notNull(),
  parentId: uuid('parent_id').references((): AnyPgColumn => accounts.id),
  isGroup: boolean('is_group').notNull().default(false),
  /** System accounts are used by the posting service and cannot be deleted/retyped. */
  isSystem: boolean('is_system').notNull().default(false),
  /** Stable key the posting service looks accounts up by (e.g. 'debtors'). */
  systemKey: text('system_key').unique(),
  /** Cash/bank accounts can receive and make payments. */
  subtype: accountSubtypeEnum('subtype'),
  active: boolean('active').notNull().default(true),
  ...stamps,
});

export const expenseCategories = pgTable('expense_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  active: boolean('active').notNull().default(true),
  ...stamps,
});

// ----------------------------------------------------------------------------
// 8.3 leads (declared before parties because of the two-way link)
// ----------------------------------------------------------------------------
export const leads = pgTable('leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  leadNo: text('lead_no').notNull().unique(),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  email: text('email'),
  sourceId: uuid('source_id').notNull().references(() => leadSources.id),
  sourceDetail: text('source_detail'),
  campaignId: uuid('campaign_id').references(() => campaigns.id),
  externalRef: text('external_ref').unique(),
  interestedItemIds: uuid('interested_item_ids').array().notNull().default(sql`'{}'::uuid[]`),
  stage: leadStageEnum('stage').notNull().default('new'),
  /**
   * What the deal is expected to be worth, as the salesperson judges it. Blank = not judged yet, and
   * the pipeline then counts the prices of the items the lead asked about instead.
   */
  dealValue: money('deal_value'),
  lostReasonId: uuid('lost_reason_id').references(() => lostReasons.id),
  ownerId: uuid('owner_id').references(() => users.id),
  nextFollowUpAt: ts('next_follow_up_at'),
  attendedBy: uuid('attended_by').references(() => users.id),
  partyId: uuid('party_id').references((): AnyPgColumn => parties.id),
  convertedAt: ts('converted_at'),
  firstContactedAt: ts('first_contacted_at'),
  address: jsonb('address'),
  gstin: text('gstin'),
  notes: text('notes'),
  /** The follow-up plan this lead is on, which step comes next (0 = the first), and when the plan was started. */
  planId: uuid('plan_id').references((): AnyPgColumn => followUpPlans.id),
  planStep: integer('plan_step'),
  planStartedAt: ts('plan_started_at'),
  ...stamps,
}, (t) => [
  index('leads_phone_idx').on(t.phone),
  index('leads_stage_idx').on(t.stage),
  index('leads_owner_idx').on(t.ownerId),
  index('leads_follow_up_idx').on(t.nextFollowUpAt),
  check('leads_lost_reason_chk', sql`${t.stage} <> 'lost' or ${t.lostReasonId} is not null`),
  check('leads_follow_up_chk',
    sql`${t.stage} not in ('contacted','interested','meeting_booked') or ${t.nextFollowUpAt} is not null`),
]);

/**
 * A follow-up plan: steps over days and weeks, each with what to do and, if it is a message, the
 * quick reply to send. Steps are [{ after_days, what, template_id }], in order of the day.
 */
export const followUpPlans = pgTable('follow_up_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  steps: jsonb('steps').notNull(),
  /** The plan every new lead is put on. At most one. */
  isDefault: boolean('is_default').notNull().default(false),
  active: boolean('active').notNull().default(true),
  ...stamps,
});

export const leadActivities = pgTable('lead_activities', {
  id: uuid('id').primaryKey().defaultRandom(),
  leadId: uuid('lead_id').notNull().references(() => leads.id),
  type: leadActivityTypeEnum('type').notNull(),
  note: text('note'),
  at: ts('at').notNull().defaultNow(),
  userId: uuid('user_id').references(() => users.id),
}, (t) => [index('lead_activities_lead_idx').on(t.leadId)]);

// ----------------------------------------------------------------------------
// 8.2 parties
// ----------------------------------------------------------------------------
export const parties = pgTable('parties', {
  id: uuid('id').primaryKey().defaultRandom(),
  partyType: partyTypeEnum('party_type').notNull(),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email'),
  gstin: text('gstin'),
  /** Needed on TDS returns. Read from the GSTIN when there is one. */
  pan: text('pan'),
  stateCode: char('state_code', { length: 2 }),
  billingAddress: jsonb('billing_address'),
  shippingAddress: jsonb('shipping_address'),
  priceListId: uuid('price_list_id').references(() => priceLists.id),
  creditLimit: money('credit_limit'),
  paymentTermsDays: integer('payment_terms_days'),
  leadId: uuid('lead_id').references((): AnyPgColumn => leads.id),
  active: boolean('active').notNull().default(true),
  ...stamps,
}, (t) => [
  index('parties_phone_idx').on(t.phone),
  // One row per (phone, role): the same person can be a customer and a supplier via two rows.
  uniqueIndex('parties_phone_type_uq').on(t.phone, t.partyType).where(sql`${t.phone} is not null`),
]);

// ----------------------------------------------------------------------------
// 8.4 items
// ----------------------------------------------------------------------------
export const items = pgTable('items', {
  id: uuid('id').primaryKey().defaultRandom(),
  sku: text('sku').notNull().unique(),
  name: text('name').notNull(),
  itemType: itemTypeEnum('item_type').notNull(),
  categoryId: uuid('category_id').references(() => itemCategories.id),
  hsnSac: text('hsn_sac'),
  gstRate: pct('gst_rate').notNull().default('18'),
  unit: text('unit').notNull().default('Nos'),
  purchaseCost: money('purchase_cost').notNull().default('0'),
  mrp: money('mrp').notNull().default('0'),
  retailPrice: money('retail_price').notNull().default('0'),
  dealerPrice: money('dealer_price').notNull().default('0'),
  reorderLevel: qty('reorder_level'),
  barcode: text('barcode').unique(),
  isStockItem: boolean('is_stock_item').notNull().default(true),
  active: boolean('active').notNull().default(true),
  ...stamps,
}, (t) => [check('items_gst_rate_chk', sql`${t.gstRate} in (0, 5, 12, 18, 28)`)]);

export const itemImages = pgTable('item_images', {
  id: uuid('id').primaryKey().defaultRandom(),
  itemId: uuid('item_id').notNull().references(() => items.id),
  url: text('url').notNull(),
  sort: integer('sort').notNull().default(0),
  ...stamps,
});

export const priceListItems = pgTable('price_list_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  priceListId: uuid('price_list_id').notNull().references(() => priceLists.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  rate: money('rate').notNull(),
  ...stamps,
}, (t) => [unique('price_list_items_uq').on(t.priceListId, t.itemId)]);

export const channelItemMap = pgTable('channel_item_map', {
  id: uuid('id').primaryKey().defaultRandom(),
  channel: channelEnum('channel').notNull(),
  itemId: uuid('item_id').notNull().references(() => items.id),
  externalProductId: text('external_product_id').notNull(),
  externalVariantId: text('external_variant_id').notNull().default(''),
  ...stamps,
}, (t) => [unique('channel_item_map_uq').on(t.channel, t.externalProductId, t.externalVariantId)]);

// ----------------------------------------------------------------------------
// 8.5 stock_movements - the single inventory ledger (append-only, see triggers)
// ----------------------------------------------------------------------------
export const stockMovements = pgTable('stock_movements', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  itemId: uuid('item_id').notNull().references(() => items.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  qty: qty('qty').notNull(),
  unitCost: money('unit_cost').notNull(),
  /** Signed stock value of this row (same sign as qty). Valuation = sum(value); the GL posts this figure. */
  value: numeric('value', { precision: 14, scale: 2 }).notNull(),
  movementType: movementTypeEnum('movement_type').notNull(),
  refType: text('ref_type').notNull(),
  refId: uuid('ref_id').notNull(),
  reason: text('reason'),
  postedAt: ts('posted_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
}, (t) => [
  index('stock_movements_item_loc_idx').on(t.itemId, t.locationId),
  index('stock_movements_ref_idx').on(t.refType, t.refId),
  check('stock_movements_qty_nonzero', sql`${t.qty} <> 0`),
]);

export const stockTransfers = pgTable('stock_transfers', {
  id: uuid('id').primaryKey().defaultRandom(),
  transferNo: text('transfer_no').notNull().unique(),
  fromLocationId: uuid('from_location_id').notNull().references(() => locations.id),
  toLocationId: uuid('to_location_id').notNull().references(() => locations.id),
  reason: text('reason').notNull(),
  transferredAt: ts('transferred_at').notNull().defaultNow(),
  ...stamps,
}, (t) => [check('stock_transfers_diff_loc', sql`${t.fromLocationId} <> ${t.toLocationId}`)]);

export const stockTransferLines = pgTable('stock_transfer_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  transferId: uuid('transfer_id').notNull().references(() => stockTransfers.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  qty: qty('qty').notNull(),
}, (t) => [index('stock_transfer_lines_transfer_idx').on(t.transferId), check('stock_transfer_lines_qty_pos', sql`${t.qty} > 0`)]);

/** Adjustments, physical counts and opening stock. Posts to the ledger only when approved. */
export const stockAdjustments = pgTable('stock_adjustments', {
  id: uuid('id').primaryKey().defaultRandom(),
  adjustmentNo: text('adjustment_no').notNull().unique(),
  kind: adjustmentKindEnum('kind').notNull(),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  reason: text('reason').notNull(),
  status: adjustmentStatusEnum('status').notNull().default('pending'),
  decidedBy: uuid('decided_by').references(() => users.id),
  decidedAt: ts('decided_at'),
  ...stamps,
});

export const stockAdjustmentLines = pgTable('stock_adjustment_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  adjustmentId: uuid('adjustment_id').notNull().references(() => stockAdjustments.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  /** For counts: what the system said and what was physically counted. */
  systemQty: qty('system_qty'),
  countedQty: qty('counted_qty'),
  qtyChange: qty('qty_change').notNull(),
  /** Cost for stock coming in; null means use the current valuation rate. */
  unitCost: money('unit_cost'),
}, (t) => [index('stock_adjustment_lines_adjustment_idx').on(t.adjustmentId)]);

// ----------------------------------------------------------------------------
// Job work: our material sent to an outside worker on a challan, and what comes back
// ----------------------------------------------------------------------------
export const jobWorkStatusEnum = pgEnum('job_work_status', ['open', 'closed', 'cancelled']);

/**
 * The challan the material travels on. The material stays ours: it moves to the "With job
 * workers" place in stock and its value does not change. The challan is open until every unit
 * sent has been accounted for (come back, used up in what was made, or lost).
 */
export const jobWorks = pgTable('job_works', {
  id: uuid('id').primaryKey().defaultRandom(),
  challanNo: text('challan_no').notNull().unique(),
  challanDate: date('challan_date').notNull(),
  jobWorkerId: uuid('job_worker_id').notNull().references(() => parties.id),
  fromLocationId: uuid('from_location_id').notNull().references(() => locations.id),
  /** What is to be done to the material: powder coating, welding, painting. Printed on the challan. */
  process: text('process').notNull(),
  expectedBackOn: date('expected_back_on'),
  /** How it travels (vehicle number, transporter), for the challan. */
  transport: text('transport'),
  notes: text('notes'),
  status: jobWorkStatusEnum('status').notNull().default('open'),
  closedAt: ts('closed_at'),
  ...stamps,
}, (t) => [index('job_works_worker_idx').on(t.jobWorkerId), index('job_works_status_idx').on(t.status)]);

/** What was sent, at what it stood in the books that day. How much is still out is worked out from the receipts. */
export const jobWorkLines = pgTable('job_work_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobWorkId: uuid('job_work_id').notNull().references(() => jobWorks.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  qty: qty('qty').notNull(),
  unitCost: money('unit_cost').notNull(),
  value: numeric('value', { precision: 14, scale: 2 }).notNull(),
  ...stamps,
}, (t) => [
  unique('job_work_lines_item_uq').on(t.jobWorkId, t.itemId),
  check('job_work_lines_qty_pos', sql`${t.qty} > 0`),
]);

/**
 * One occasion on which something came back (or was written off) against a challan. `charge` is
 * the job worker's charge for this lot before GST, when it is to be part of the cost of the goods:
 * it is added to their value and owed until the job worker's bill is booked.
 */
export const jobWorkReceipts = pgTable('job_work_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  receiptNo: text('receipt_no').notNull().unique(),
  jobWorkId: uuid('job_work_id').notNull().references(() => jobWorks.id),
  receivedOn: date('received_on').notNull(),
  toLocationId: uuid('to_location_id').notNull().references(() => locations.id),
  workerChallanNo: text('worker_challan_no'),
  charge: money('charge').notNull().default('0'),
  notes: text('notes'),
  status: postedStatusEnum('status').notNull().default('posted'),
  ...stamps,
}, (t) => [index('job_work_receipts_job_idx').on(t.jobWorkId), check('job_work_receipts_charge_chk', sql`${t.charge} >= 0`)]);

/**
 * What a receipt did, line by line:
 * - returned: material that came back as the same item
 * - consumed: material used up at the job worker in making the produced goods
 * - produced: the goods made from it, valued at what was consumed (plus the charge)
 * - lost:     material that will not come back (damaged or missing), written off
 * `value` is the stock value the line moved, kept so that a receipt can be undone exactly.
 */
export const jobWorkReceiptLines = pgTable('job_work_receipt_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  receiptId: uuid('receipt_id').notNull().references(() => jobWorkReceipts.id),
  kind: text('kind').notNull(),
  /** The challan line this is about; empty for the produced goods. */
  jobWorkLineId: uuid('job_work_line_id').references(() => jobWorkLines.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  qty: qty('qty').notNull(),
  value: numeric('value', { precision: 14, scale: 2 }).notNull(),
  /** For a returned line: the share of the charge added to its value on the way back in. */
  chargeShare: money('charge_share').notNull().default('0'),
}, (t) => [
  index('job_work_receipt_lines_receipt_idx').on(t.receiptId),
  index('job_work_receipt_lines_line_idx').on(t.jobWorkLineId),
  check('job_work_receipt_lines_kind_chk', sql`${t.kind} in ('returned', 'consumed', 'produced', 'lost')`),
  check('job_work_receipt_lines_qty_pos', sql`${t.qty} > 0`),
]);

// ----------------------------------------------------------------------------
// 8.6 sales orders (a Draft order is the quote)
// ----------------------------------------------------------------------------
export const salesOrders = pgTable('sales_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderNo: text('order_no').notNull().unique(),
  channel: channelEnum('channel').notNull(),
  externalOrderId: text('external_order_id'),
  partyId: uuid('party_id').references(() => parties.id),
  leadId: uuid('lead_id').references(() => leads.id),
  status: orderStatusEnum('status').notNull().default('draft'),
  placeOfSupply: char('place_of_supply', { length: 2 }).notNull(),
  taxInclusive: boolean('tax_inclusive').notNull().default(false),
  orderDate: date('order_date').notNull(),
  notes: text('notes'),
  ...stamps,
}, (t) => [
  unique('sales_orders_channel_ext_uq').on(t.channel, t.externalOrderId),
  index('sales_orders_party_idx').on(t.partyId),
  index('sales_orders_date_idx').on(t.orderDate),
]);

export const salesOrderLines = pgTable('sales_order_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => salesOrders.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  qty: qty('qty').notNull(),
  rate: money('rate').notNull(),
  discount: money('discount').notNull().default('0'),
  gstRate: pct('gst_rate').notNull(),
  deliveredQty: qty('delivered_qty').notNull().default('0'),
  invoicedQty: qty('invoiced_qty').notNull().default('0'),
  sort: integer('sort').notNull().default(0),
}, (t) => [
  index('sales_order_lines_order_idx').on(t.orderId),
  check('sol_qty_pos', sql`${t.qty} > 0`),
  check('sol_delivered_chk', sql`${t.deliveredQty} >= 0 and ${t.deliveredQty} <= ${t.qty}`),
  check('sol_invoiced_chk', sql`${t.invoicedQty} >= 0 and ${t.invoicedQty} <= ${t.deliveredQty}`),
]);

/** Delivery note / challan: the document that takes stock out. Partial deliveries allowed. */
export const deliveries = pgTable('deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  deliveryNo: text('delivery_no').notNull().unique(),
  orderId: uuid('order_id').notNull().references(() => salesOrders.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  deliveredAt: ts('delivered_at').notNull().defaultNow(),
  notes: text('notes'),
  ...stamps,
}, (t) => [index('deliveries_order_idx').on(t.orderId)]);

export const deliveryLines = pgTable('delivery_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  deliveryId: uuid('delivery_id').notNull().references(() => deliveries.id),
  orderLineId: uuid('order_line_id').notNull().references(() => salesOrderLines.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  qty: qty('qty').notNull(),
  /** Valuation rate at the moment of delivery (drives COGS). */
  unitCost: money('unit_cost').notNull(),
}, (t) => [index('delivery_lines_delivery_idx').on(t.deliveryId), check('delivery_lines_qty_pos', sql`${t.qty} > 0`)]);

// ----------------------------------------------------------------------------
// 8.7 invoices - legal record, immutable once issued (see triggers)
// ----------------------------------------------------------------------------
export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  docType: invoiceDocTypeEnum('doc_type').notNull(),
  invoiceNo: text('invoice_no'),
  fy: text('fy'),
  invoiceDate: date('invoice_date').notNull(),
  partyId: uuid('party_id').references(() => parties.id),
  orderId: uuid('order_id').references(() => salesOrders.id),
  againstInvoiceId: uuid('against_invoice_id').references((): AnyPgColumn => invoices.id),
  channel: channelEnum('channel'),
  placeOfSupply: char('place_of_supply', { length: 2 }).notNull(),
  taxInclusive: boolean('tax_inclusive').notNull().default(false),
  // Frozen at issue so the document never changes if the party later does.
  partyName: text('party_name'),
  partyGstin: text('party_gstin'),
  partyPhone: text('party_phone'),
  billingAddress: jsonb('billing_address'),
  shippingAddress: jsonb('shipping_address'),
  taxableTotal: money('taxable_total').notNull().default('0'),
  cgstTotal: money('cgst_total').notNull().default('0'),
  sgstTotal: money('sgst_total').notNull().default('0'),
  igstTotal: money('igst_total').notNull().default('0'),
  roundOff: money('round_off').notNull().default('0'),
  grandTotal: money('grand_total').notNull().default('0'),
  dueDate: date('due_date'),
  status: invoiceStatusEnum('status').notNull().default('draft'),
  issuedAt: ts('issued_at'),
  cancelledAt: ts('cancelled_at'),
  cancelReason: text('cancel_reason'),
  reason: text('reason'),
  irn: text('irn'),
  ewayBillNo: text('eway_bill_no'),
  notes: text('notes'),
  ...stamps,
}, (t) => [
  unique('invoices_no_fy_uq').on(t.docType, t.invoiceNo, t.fy),
  index('invoices_party_idx').on(t.partyId),
  index('invoices_date_idx').on(t.invoiceDate),
  index('invoices_order_idx').on(t.orderId),
  index('invoices_against_idx').on(t.againstInvoiceId),
  check('invoices_no_len_chk', sql`${t.invoiceNo} is null or char_length(${t.invoiceNo}) <= 16`),
  check('invoices_issued_no_chk', sql`${t.status} = 'draft' or ${t.invoiceNo} is not null`),
]);

export const invoiceLines = pgTable('invoice_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id),
  orderLineId: uuid('order_line_id').references(() => salesOrderLines.id),
  /** For credit notes: the invoice line being returned. */
  againstLineId: uuid('against_line_id').references((): AnyPgColumn => invoiceLines.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  description: text('description').notNull(),
  hsnSac: text('hsn_sac'),
  unit: text('unit').notNull().default('Nos'),
  qty: qty('qty').notNull(),
  rate: money('rate').notNull(),
  discount: money('discount').notNull().default('0'),
  taxableValue: money('taxable_value').notNull(),
  gstRate: pct('gst_rate').notNull(),
  cgst: money('cgst').notNull().default('0'),
  sgst: money('sgst').notNull().default('0'),
  igst: money('igst').notNull().default('0'),
  lineTotal: money('line_total').notNull(),
  /** Cost of the goods on this line (from the delivery) - used when a return restocks. */
  unitCost: money('unit_cost').notNull().default('0'),
  sort: integer('sort').notNull().default(0),
}, (t) => [index('invoice_lines_invoice_idx').on(t.invoiceId), index('invoice_lines_against_idx').on(t.againstLineId)]);

// ----------------------------------------------------------------------------
// Purchasing: PO -> supplier bill -> goods receipt with QC -> supplier return
// ----------------------------------------------------------------------------
export const purchaseOrders = pgTable('purchase_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  poNo: text('po_no').notNull().unique(),
  supplierId: uuid('supplier_id').notNull().references(() => parties.id),
  status: poStatusEnum('status').notNull().default('draft'),
  orderDate: date('order_date').notNull(),
  expectedDate: date('expected_date'),
  notes: text('notes'),
  ...stamps,
}, (t) => [index('purchase_orders_supplier_idx').on(t.supplierId)]);

export const purchaseOrderLines = pgTable('purchase_order_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  purchaseOrderId: uuid('purchase_order_id').notNull().references(() => purchaseOrders.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  qty: qty('qty').notNull(),
  rate: money('rate').notNull(),
  gstRate: pct('gst_rate').notNull(),
  /** Quantity physically received so far (accepted + rejected). */
  receivedQty: qty('received_qty').notNull().default('0'),
  sort: integer('sort').notNull().default(0),
}, (t) => [index('purchase_order_lines_po_idx').on(t.purchaseOrderId), check('pol_qty_pos', sql`${t.qty} > 0`)]);

export const purchaseBills = pgTable('purchase_bills', {
  id: uuid('id').primaryKey().defaultRandom(),
  docType: billDocTypeEnum('doc_type').notNull(),
  /** Our own number: PB/.. for bills, DN/.. (GST debit-note series) for debit notes. */
  billNo: text('bill_no').notNull(),
  fy: text('fy').notNull(),
  supplierInvoiceNo: text('supplier_invoice_no'),
  billDate: date('bill_date').notNull(),
  dueDate: date('due_date'),
  supplierId: uuid('supplier_id').notNull().references(() => parties.id),
  purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrders.id),
  againstBillId: uuid('against_bill_id').references((): AnyPgColumn => purchaseBills.id),
  placeOfSupply: char('place_of_supply', { length: 2 }).notNull(),
  taxableTotal: money('taxable_total').notNull(),
  cgstTotal: money('cgst_total').notNull().default('0'),
  sgstTotal: money('sgst_total').notNull().default('0'),
  igstTotal: money('igst_total').notNull().default('0'),
  roundOff: money('round_off').notNull().default('0'),
  grandTotal: money('grand_total').notNull(),
  /** Quantity/rate mismatches against the PO or receipt (PRD 7.7). */
  mismatches: jsonb('mismatches'),
  /**
   * A job worker's bill for a challan. `jobWorkCleared` is how much of the bill settled charges
   * that had already been added to the cost of goods when they came back; the rest is an expense.
   */
  jobWorkId: uuid('job_work_id').references(() => jobWorks.id),
  jobWorkCleared: money('job_work_cleared').notNull().default('0'),
  status: billStatusEnum('status').notNull().default('posted'),
  notes: text('notes'),
  ...stamps,
}, (t) => [
  unique('purchase_bills_no_fy_uq').on(t.docType, t.billNo, t.fy),
  uniqueIndex('purchase_bills_supplier_inv_uq').on(t.supplierId, t.supplierInvoiceNo)
    .where(sql`${t.docType} = 'bill' and ${t.status} = 'posted' and ${t.supplierInvoiceNo} is not null`),
  index('purchase_bills_supplier_idx').on(t.supplierId),
  index('purchase_bills_po_idx').on(t.purchaseOrderId),
  index('purchase_bills_against_idx').on(t.againstBillId),
  index('purchase_bills_job_work_idx').on(t.jobWorkId),
]);

export const purchaseBillLines = pgTable('purchase_bill_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  billId: uuid('bill_id').notNull().references(() => purchaseBills.id),
  poLineId: uuid('po_line_id').references(() => purchaseOrderLines.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  description: text('description').notNull(),
  hsnSac: text('hsn_sac'),
  qty: qty('qty').notNull(),
  rate: money('rate').notNull(),
  taxableValue: money('taxable_value').notNull(),
  gstRate: pct('gst_rate').notNull(),
  cgst: money('cgst').notNull().default('0'),
  sgst: money('sgst').notNull().default('0'),
  igst: money('igst').notNull().default('0'),
  lineTotal: money('line_total').notNull(),
  sort: integer('sort').notNull().default(0),
}, (t) => [index('purchase_bill_lines_bill_idx').on(t.billId)]);

export const goodsReceipts = pgTable('goods_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  grnNo: text('grn_no').notNull().unique(),
  supplierId: uuid('supplier_id').notNull().references(() => parties.id),
  purchaseOrderId: uuid('purchase_order_id').notNull().references(() => purchaseOrders.id),
  receivedAt: ts('received_at').notNull().defaultNow(),
  /** received = counted, waiting for QC (not in stock). inwarded = QC done, stock posted. */
  status: grnStatusEnum('status').notNull().default('received'),
  notes: text('notes'),
  ...stamps,
}, (t) => [index('goods_receipts_po_idx').on(t.purchaseOrderId)]);

export const goodsReceiptLines = pgTable('goods_receipt_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  grnId: uuid('grn_id').notNull().references(() => goodsReceipts.id),
  poLineId: uuid('po_line_id').notNull().references(() => purchaseOrderLines.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  receivedQty: qty('received_qty').notNull(),
  acceptedQty: qty('accepted_qty'),
  rejectedQty: qty('rejected_qty'),
  rejectReason: text('reject_reason'),
  /** Rate from the PO: accepted stock is valued at this. */
  rate: money('rate').notNull(),
  /** Rejected quantity already sent back to the supplier. */
  returnedQty: qty('returned_qty').notNull().default('0'),
  qcBy: uuid('qc_by').references(() => users.id),
  qcAt: ts('qc_at'),
}, (t) => [
  index('goods_receipt_lines_grn_idx').on(t.grnId),
  check('grl_received_pos', sql`${t.receivedQty} > 0`),
  check('grl_qc_split_chk',
    sql`${t.acceptedQty} is null or (${t.acceptedQty} >= 0 and ${t.rejectedQty} >= 0 and ${t.acceptedQty} + ${t.rejectedQty} = ${t.receivedQty})`),
  check('grl_reject_reason_chk',
    sql`coalesce(${t.rejectedQty}, 0) = 0 or (${t.rejectReason} is not null and length(trim(${t.rejectReason})) > 0)`),
  check('grl_returned_chk', sql`${t.returnedQty} >= 0 and ${t.returnedQty} <= coalesce(${t.rejectedQty}, 0)`),
]);

export const purchaseReturns = pgTable('purchase_returns', {
  id: uuid('id').primaryKey().defaultRandom(),
  returnNo: text('return_no').notNull().unique(),
  grnId: uuid('grn_id').notNull().references(() => goodsReceipts.id),
  supplierId: uuid('supplier_id').notNull().references(() => parties.id),
  debitNoteId: uuid('debit_note_id').references(() => purchaseBills.id),
  returnedAt: ts('returned_at').notNull().defaultNow(),
  notes: text('notes'),
  ...stamps,
}, (t) => [index('purchase_returns_grn_idx').on(t.grnId)]);

export const purchaseReturnLines = pgTable('purchase_return_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  returnId: uuid('return_id').notNull().references(() => purchaseReturns.id),
  grnLineId: uuid('grn_line_id').notNull().references(() => goodsReceiptLines.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  qty: qty('qty').notNull(),
  rate: money('rate').notNull(),
}, (t) => [index('purchase_return_lines_return_idx').on(t.returnId)]);

// ----------------------------------------------------------------------------
// 8.9 payments
// ----------------------------------------------------------------------------
/**
 * TDS (tax deducted at source): the kinds of payment tax is held back from, and at what rate.
 * The law's own numbering changed on 1 April 2026, so the reference and the return's code are
 * kept as text an accountant can correct, not built into the program.
 */
export const tdsRates = pgTable('tds_rates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  lawReference: text('law_reference'),
  returnCode: text('return_code'),
  rate: pct('rate').notNull(),
  active: boolean('active').notNull().default(true),
  ...stamps,
}, (t) => [check('tds_rates_rate_chk', sql`${t.rate} > 0 and ${t.rate} <= 100`)]);

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  paymentNo: text('payment_no').notNull().unique(),
  direction: paymentDirectionEnum('direction').notNull(),
  partyId: uuid('party_id').references(() => parties.id),
  mode: paymentModeEnum('mode').notNull(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  /** The money that actually moved through cash or the bank. */
  amount: money('amount').notNull(),
  /**
   * Tax held back on this payment: by us from a supplier (money out), or by the customer from
   * us (money in). The party's account is settled for amount + tds_amount, and that much can be
   * set against invoices or bills. tds_base is what the tax was worked out on.
   */
  tdsAmount: money('tds_amount').notNull().default('0'),
  tdsRateId: uuid('tds_rate_id').references(() => tdsRates.id),
  tdsBase: money('tds_base'),
  reference: text('reference'),
  paidOn: date('paid_on').notNull(),
  status: postedStatusEnum('status').notNull().default('posted'),
  notes: text('notes'),
  ...stamps,
}, (t) => [
  index('payments_party_idx').on(t.partyId),
  check('payments_amount_pos', sql`${t.amount} > 0`),
  check('payments_tds_chk', sql`${t.tdsAmount} >= 0`),
]);

/** TDS paid over to the government: what we held back from vendors, or from salaries. */
export const tdsDeposits = pgTable('tds_deposits', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  paidOn: date('paid_on').notNull(),
  amount: money('amount').notNull(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  /** The month whose deductions this pays, as YYYY-MM. */
  month: char('month', { length: 7 }).notNull(),
  challanNo: text('challan_no'),
  bsrCode: text('bsr_code'),
  notes: text('notes'),
  status: postedStatusEnum('status').notNull().default('posted'),
  ...stamps,
}, (t) => [
  check('tds_deposits_amount_pos', sql`${t.amount} > 0`),
  check('tds_deposits_kind_chk', sql`${t.kind} in ('vendor', 'salary')`),
]);

export const paymentAllocations = pgTable('payment_allocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  paymentId: uuid('payment_id').notNull().references(() => payments.id),
  invoiceId: uuid('invoice_id').references(() => invoices.id),
  purchaseBillId: uuid('purchase_bill_id').references(() => purchaseBills.id),
  amount: money('amount').notNull(),
  ...stamps,
}, (t) => [
  index('payment_allocations_payment_idx').on(t.paymentId),
  index('payment_allocations_invoice_idx').on(t.invoiceId),
  index('payment_allocations_bill_idx').on(t.purchaseBillId),
  check('payment_allocations_amount_pos', sql`${t.amount} > 0`),
  check('payment_allocations_one_target',
    sql`(${t.invoiceId} is not null)::int + (${t.purchaseBillId} is not null)::int = 1`),
]);

export const expenses = pgTable('expenses', {
  id: uuid('id').primaryKey().defaultRandom(),
  expenseNo: text('expense_no').notNull().unique(),
  expenseDate: date('expense_date').notNull(),
  categoryId: uuid('category_id').notNull().references(() => expenseCategories.id),
  /** Amount before GST. */
  amount: money('amount').notNull(),
  cgst: money('cgst').notNull().default('0'),
  sgst: money('sgst').notNull().default('0'),
  igst: money('igst').notNull().default('0'),
  /** Total input GST claimed (= cgst + sgst + igst). */
  gstAmount: money('gst_amount').notNull().default('0'),
  paidFromAccountId: uuid('paid_from_account_id').notNull().references(() => accounts.id),
  vendorName: text('vendor_name'),
  vendorGstin: text('vendor_gstin'),
  /** Tax we held back when paying this (rent, a contractor, a professional): the vendor got the total less this. */
  tdsAmount: money('tds_amount').notNull().default('0'),
  tdsRateId: uuid('tds_rate_id').references(() => tdsRates.id),
  vendorPan: text('vendor_pan'),
  attachmentUrl: text('attachment_url'),
  notes: text('notes'),
  status: postedStatusEnum('status').notNull().default('posted'),
  ...stamps,
}, (t) => [
  check('expenses_amount_pos', sql`${t.amount} > 0`),
  check('expenses_tds_chk', sql`${t.tdsAmount} >= 0 and ${t.tdsAmount} <= ${t.amount}`),
]);

// ----------------------------------------------------------------------------
// 8.10 journal - append-only double entry (see triggers)
// ----------------------------------------------------------------------------
export const journalEntries = pgTable('journal_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  entryNo: bigserial('entry_no', { mode: 'number' }).notNull(),
  entryDate: date('entry_date').notNull(),
  refType: text('ref_type').notNull(),
  refId: uuid('ref_id'),
  narration: text('narration'),
  /** Set on a reversal entry: the entry it cancels. */
  reversesEntryId: uuid('reverses_entry_id').references((): AnyPgColumn => journalEntries.id),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
}, (t) => [
  index('journal_entries_date_idx').on(t.entryDate),
  index('journal_entries_ref_idx').on(t.refType, t.refId),
  // "Has this entry been reversed?" is asked of every entry by the reports, the day book and the bank screen.
  index('journal_entries_reverses_idx').on(t.reversesEntryId),
]);

export const journalLines = pgTable('journal_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  entryId: uuid('entry_id').notNull().references(() => journalEntries.id),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  partyId: uuid('party_id').references(() => parties.id),
  debit: money('debit').notNull().default('0'),
  credit: money('credit').notNull().default('0'),
  memo: text('memo'),
}, (t) => [
  index('journal_lines_entry_idx').on(t.entryId),
  index('journal_lines_account_idx').on(t.accountId),
  index('journal_lines_party_idx').on(t.partyId),
  check('journal_lines_nonneg', sql`${t.debit} >= 0 and ${t.credit} >= 0`),
  check('journal_lines_one_side', sql`(${t.debit} = 0) <> (${t.credit} = 0)`),
]);

/**
 * A credit note's unused credit set against another invoice of the same customer. When goods
 * are returned on an invoice that was already paid, the credit note leaves the customer in
 * credit; this is how that credit pays down a later invoice. No journal entry is needed: both
 * sides are the same customer's balance in Debtors, so it only changes which invoice is open.
 */
export const creditApplications = pgTable('credit_applications', {
  id: uuid('id').primaryKey().defaultRandom(),
  creditNoteId: uuid('credit_note_id').notNull().references(() => invoices.id),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id),
  amount: money('amount').notNull(),
  appliedOn: date('applied_on').notNull(),
  status: postedStatusEnum('status').notNull().default('posted'),
  ...stamps,
}, (t) => [
  index('credit_applications_cn_idx').on(t.creditNoteId),
  index('credit_applications_invoice_idx').on(t.invoiceId),
  check('credit_applications_amount_chk', sql`${t.amount} > 0`),
  check('credit_applications_distinct_chk', sql`${t.creditNoteId} <> ${t.invoiceId}`),
]);

/**
 * Year-end close: one row per financial year that has been closed. The closing journal entry
 * (ref_type 'year_close') moves that year's income and expenses into Retained Earnings.
 * Reopening a year reverses the entry and removes the row.
 */
export const fiscalCloses = pgTable('fiscal_closes', {
  id: uuid('id').primaryKey().defaultRandom(),
  fy: text('fy').notNull().unique(),
  fromDate: date('from_date').notNull(),
  toDate: date('to_date').notNull(),
  /** Null when the year had nothing to close. */
  entryId: uuid('entry_id').references(() => journalEntries.id),
  income: numeric('income', { precision: 16, scale: 2 }).notNull().default('0'),
  expense: numeric('expense', { precision: 16, scale: 2 }).notNull().default('0'),
  profit: numeric('profit', { precision: 16, scale: 2 }).notNull().default('0'),
  ...stamps,
});

// ----------------------------------------------------------------------------
// Bank reconciliation: statement lines imported from the bank, matched one-to-one to the
// journal line that recorded the same movement on that bank account.
// ----------------------------------------------------------------------------
export const bankLineStatusEnum = pgEnum('bank_line_status', ['unmatched', 'matched', 'ignored']);

export const bankStatementLines = pgTable('bank_statement_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  txnDate: date('txn_date').notNull(),
  description: text('description').notNull().default(''),
  reference: text('reference'),
  /** Signed, from our side: positive = money into the account, negative = money out. */
  amount: money('amount').notNull(),
  /** Running balance printed on the statement, when the bank gives one. */
  balance: numeric('balance', { precision: 14, scale: 2 }),
  importId: uuid('import_id').notNull(),
  /** Position within its import, oldest first, so the last row of a day (and its balance) is known. */
  seq: integer('seq').notNull().default(0),
  /** Identifies the statement row, so importing the same or an overlapping file adds nothing twice. */
  lineHash: text('line_hash').notNull(),
  status: bankLineStatusEnum('status').notNull().default('unmatched'),
  matchedAt: ts('matched_at'),
  matchedBy: uuid('matched_by').references(() => users.id),
  ignoreReason: text('ignore_reason'),
  ...stamps,
}, (t) => [
  unique('bank_statement_lines_hash_uq').on(t.accountId, t.lineHash),
  index('bank_statement_lines_account_date_idx').on(t.accountId, t.txnDate),
  check('bank_statement_lines_amount_nonzero', sql`${t.amount} <> 0`),
]);

/**
 * Which book entries explain a statement line. Usually one, but one bank line can stand for
 * several entries: a card-machine payout that covers a day's receipts, less the bank's fee.
 * A book entry explains at most one statement line.
 */
export const bankLineMatches = pgTable('bank_line_matches', {
  id: uuid('id').primaryKey().defaultRandom(),
  statementLineId: uuid('statement_line_id').notNull().references(() => bankStatementLines.id),
  journalLineId: bigint('journal_line_id', { mode: 'number' }).notNull().unique().references(() => journalLines.id),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [index('bank_line_matches_statement_idx').on(t.statementLineId)]);

// ----------------------------------------------------------------------------
// Integrations
// ----------------------------------------------------------------------------
export const channelEvents = pgTable('channel_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  channel: text('channel').notNull(),
  eventType: text('event_type').notNull(),
  externalId: text('external_id').notNull(),
  payload: jsonb('payload').notNull(),
  status: eventStatusEnum('status').notNull().default('received'),
  error: text('error'),
  /** One line a person can read: who it was and where it came from. */
  summary: text('summary'),
  /** The lead this event created or was added to. */
  leadId: uuid('lead_id').references(() => leads.id),
  /** The sales order this event created or cancelled (orders from Shopify, Amazon and Flipkart). */
  orderId: uuid('order_id').references(() => salesOrders.id),
  attempts: integer('attempts').notNull().default(0),
  processedAt: ts('processed_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [
  unique('channel_events_uq').on(t.channel, t.eventType, t.externalId),
  index('channel_events_status_idx').on(t.status, t.createdAt),
]);

/**
 * Files people attach: a resume, a photo of a bill, a picture of an item. The bytes are kept on
 * disk under the upload folder, named by this row's id; this row is what says what it is and
 * who may open it. `purpose` decides that: a resume is for HR, a bill for accounts.
 */
export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  purpose: text('purpose').notNull(),
  originalName: text('original_name').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  sha256: text('sha256').notNull(),
  ...stamps,
}, (t) => [check('files_purpose_chk', sql`${t.purpose} in ('resume', 'bill', 'item_image', 'share', 'other')`)]);

/**
 * A file sent to a lead through a link of its own, and whether they have opened it. The token is
 * the whole of the link's secret: it says nothing about who the lead is.
 */
export const leadShares = pgTable('lead_shares', {
  id: uuid('id').primaryKey().defaultRandom(),
  leadId: uuid('lead_id').notNull().references(() => leads.id),
  fileId: uuid('file_id').notNull().references(() => files.id),
  title: text('title').notNull(),
  token: text('token').notNull().unique(),
  viewCount: integer('view_count').notNull().default(0),
  firstViewedAt: ts('first_viewed_at'),
  lastViewedAt: ts('last_viewed_at'),
  revokedAt: ts('revoked_at'),
  ...stamps,
}, (t) => [index('lead_shares_lead_idx').on(t.leadId)]);

const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => 'bytea',
  fromDriver: (value) => Buffer.from(value),
});

/**
 * The bytes of an attached file, on a host with no disk of its own (FILE_STORE=database). Kept
 * apart from `files` so that listing files never drags their contents along.
 */
export const fileContents = pgTable('file_contents', {
  fileId: uuid('file_id').primaryKey().references(() => files.id, { onDelete: 'cascade' }),
  bytes: bytea('bytes').notNull(),
});

/**
 * Statements by email: for one bank account, how its statement mails are recognised (words in the
 * sender's address and in the subject) and the password that opens the attached PDF. The
 * password is kept locked (lib/secret-box.ts) and is never sent to a screen.
 */
export const bankFeeds = pgTable('bank_feeds', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').notNull().unique().references(() => accounts.id),
  matchFrom: text('match_from'),
  matchSubject: text('match_subject'),
  passwordSealed: text('password_sealed'),
  active: boolean('active').notNull().default(true),
  ...stamps,
}, (t) => [check('bank_feeds_rule_chk', sql`${t.matchFrom} is not null or ${t.matchSubject} is not null`)]);

/**
 * Every mail the statements mailbox received, one row per attachment, and what became of it.
 * The mail's own id makes sure a mail is dealt with once however often the mailbox is read. The
 * attachment is kept while it has not been imported, so it can be tried again after the
 * password or the rule is put right.
 */
export const bankMails = pgTable('bank_mails', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: text('message_id').notNull(),
  part: integer('part').notNull().default(0),
  fromAddress: text('from_address'),
  subject: text('subject'),
  receivedAt: ts('received_at'),
  accountId: uuid('account_id').references(() => accounts.id),
  attachmentName: text('attachment_name'),
  attachment: bytea('attachment'),
  status: text('status').notNull(),
  detail: text('detail'),
  importId: uuid('import_id'),
  result: jsonb('result'),
  ...stamps,
}, (t) => [
  unique('bank_mails_message_uq').on(t.messageId, t.part),
  check('bank_mails_status_chk', sql`${t.status} in ('imported', 'failed', 'ignored')`),
]);

/**
 * What was spent on advertising, so the marketing dashboard can show cost per lead. An entry is
 * for a lead source, and optionally for one campaign within it (`detail` is the campaign name as
 * it appears on the leads). This is a marketing record: the payment itself is booked under Expenses.
 */
export const adSpends = pgTable('ad_spends', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceId: uuid('source_id').notNull().references(() => leadSources.id),
  detail: text('detail'),
  spendDate: date('spend_date').notNull(),
  amount: money('amount').notNull(),
  notes: text('notes'),
  ...stamps,
}, (t) => [
  index('ad_spends_date_idx').on(t.spendDate),
  check('ad_spends_amount_chk', sql`${t.amount} > 0`),
]);

/**
 * Quick replies (CRM): ready-made messages a salesperson sends to a lead in one tap, with the
 * lead's own details filled in. Placeholders: {name}, {first_name}, {my_name}, {company}, {products}.
 */
export const messageTemplates = pgTable('message_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  body: text('body').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  ...stamps,
});

// ----------------------------------------------------------------------------
// HR (PRD 7.14, Tier 2): openings, applicants and their interviews, employees, attendance
// ----------------------------------------------------------------------------
export const openingStatusEnum = pgEnum('opening_status', OPENING_STATUSES);
export const applicantStageEnum = pgEnum('applicant_stage', APPLICANT_STAGES);
export const applicantSourceEnum = pgEnum('applicant_source', APPLICANT_SOURCES);
export const rejectReasonEnum = pgEnum('reject_reason', REJECT_REASONS);
export const applicantActivityTypeEnum = pgEnum('applicant_activity_type', APPLICANT_ACTIVITY_TYPES);
export const interviewModeEnum = pgEnum('interview_mode', INTERVIEW_MODES);
export const interviewStatusEnum = pgEnum('interview_status', INTERVIEW_STATUSES);
export const interviewResultEnum = pgEnum('interview_result', INTERVIEW_RESULTS);
export const employmentTypeEnum = pgEnum('employment_type', EMPLOYMENT_TYPES);
export const employeeStatusEnum = pgEnum('employee_status', EMPLOYEE_STATUSES);
export const attendanceStatusEnum = pgEnum('attendance_status', ATTENDANCE_STATUSES);

export const jobOpenings = pgTable('job_openings', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  department: text('department').notNull(),
  /** How many people are wanted; "filled" is counted from the applicants hired against it. */
  positions: integer('positions').notNull().default(1),
  status: openingStatusEnum('status').notNull().default('open'),
  description: text('description'),
  openedOn: date('opened_on').notNull(),
  closedOn: date('closed_on'),
  ...stamps,
}, (t) => [check('job_openings_positions_chk', sql`${t.positions} > 0`)]);

export const employees = pgTable('employees', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeNo: text('employee_no').notNull().unique(),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  email: text('email'),
  department: text('department').notNull(),
  designation: text('designation').notNull(),
  employmentType: employmentTypeEnum('employment_type').notNull().default('full_time'),
  joinDate: date('join_date').notNull(),
  monthlySalary: money('monthly_salary'),
  /** Leave days per year for this person; null means the company's usual number. */
  annualLeaveDays: numeric('annual_leave_days', { precision: 4, scale: 1 }),
  /** Their sign-in, when they have one: this is how tasks reach them. */
  userId: uuid('user_id').unique().references(() => users.id),
  /** Salary: whether PF and ESIC are deducted for this person, their professional tax and TDS per month, and where the salary is sent. */
  pfApplicable: boolean('pf_applicable').notNull().default(false),
  esicApplicable: boolean('esic_applicable').notNull().default(false),
  ptMonthly: money('pt_monthly').notNull().default('0'),
  tdsMonthly: money('tds_monthly').notNull().default('0'),
  bankAccountNo: text('bank_account_no'),
  bankIfsc: text('bank_ifsc'),
  status: employeeStatusEnum('status').notNull().default('active'),
  leftOn: date('left_on'),
  leftReason: text('left_reason'),
  notes: text('notes'),
  ...stamps,
}, (t) => [
  // A person is on the rolls once; someone who left and came back gets a new record.
  uniqueIndex('employees_active_phone_uq').on(t.phone).where(sql`${t.status} = 'active'`),
  check('employees_left_chk', sql`(${t.status} = 'left') = (${t.leftOn} is not null)`),
]);

export const applicants = pgTable('applicants', {
  id: uuid('id').primaryKey().defaultRandom(),
  applicantNo: text('applicant_no').notNull().unique(),
  /** Null for a general application not tied to an opening. */
  openingId: uuid('opening_id').references(() => jobOpenings.id),
  name: text('name').notNull(),
  phone: text('phone').notNull(),
  email: text('email'),
  source: applicantSourceEnum('source').notNull(),
  sourceDetail: text('source_detail'),
  resumeUrl: text('resume_url'),
  experienceYears: numeric('experience_years', { precision: 4, scale: 1 }),
  currentCompany: text('current_company'),
  expectedSalary: money('expected_salary'),
  stage: applicantStageEnum('stage').notNull().default('applied'),
  rejectReason: rejectReasonEnum('reject_reason'),
  ownerId: uuid('owner_id').references(() => users.id),
  appliedOn: date('applied_on').notNull(),
  /** When the applicant first got past screening: shortlisted, or called straight for an interview. */
  qualifiedAt: ts('qualified_at'),
  employeeId: uuid('employee_id').references(() => employees.id),
  /** When the application ended: hired or rejected. */
  closedAt: ts('closed_at'),
  notes: text('notes'),
  ...stamps,
}, (t) => [
  index('applicants_stage_idx').on(t.stage),
  index('applicants_opening_idx').on(t.openingId),
  index('applicants_phone_idx').on(t.phone),
  // One live application per person: a repeat is refused and pointed at the one already open.
  uniqueIndex('applicants_open_phone_uq').on(t.phone).where(sql`${t.stage} in ('applied','shortlisted','interview','offered')`),
  check('applicants_reject_reason_chk', sql`(${t.stage} = 'rejected') = (${t.rejectReason} is not null)`),
  check('applicants_hired_chk', sql`(${t.stage} = 'hired') = (${t.employeeId} is not null)`),
]);

export const applicantActivities = pgTable('applicant_activities', {
  id: uuid('id').primaryKey().defaultRandom(),
  applicantId: uuid('applicant_id').notNull().references(() => applicants.id),
  type: applicantActivityTypeEnum('type').notNull(),
  note: text('note'),
  at: ts('at').notNull().defaultNow(),
  userId: uuid('user_id').references(() => users.id),
}, (t) => [index('applicant_activities_applicant_idx').on(t.applicantId)]);

export const interviews = pgTable('interviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  applicantId: uuid('applicant_id').notNull().references(() => applicants.id),
  round: integer('round').notNull(),
  title: text('title').notNull(),
  scheduledAt: ts('scheduled_at').notNull(),
  mode: interviewModeEnum('mode').notNull().default('in_person'),
  interviewerId: uuid('interviewer_id').references(() => users.id),
  status: interviewStatusEnum('status').notNull().default('scheduled'),
  result: interviewResultEnum('result'),
  rating: integer('rating'),
  feedback: text('feedback'),
  completedAt: ts('completed_at'),
  ...stamps,
}, (t) => [
  unique('interviews_round_uq').on(t.applicantId, t.round),
  index('interviews_when_idx').on(t.scheduledAt),
  index('interviews_interviewer_idx').on(t.interviewerId),
  check('interviews_result_chk', sql`(${t.status} = 'completed') = (${t.result} is not null)`),
  check('interviews_rating_chk', sql`${t.rating} is null or ${t.rating} between 1 and 5`),
]);

export const attendance = pgTable('attendance', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  date: date('date').notNull(),
  status: attendanceStatusEnum('status').notNull(),
  checkIn: time('check_in'),
  checkOut: time('check_out'),
  note: text('note'),
  /** True when the person clocked in themselves from their phone, rather than HR marking the register. */
  selfMarked: boolean('self_marked').notNull().default(false),
  /** Where they were when they clocked in and out, and how far that was from the workplace (metres). Null = no location given. */
  inLat: numeric('in_lat', { precision: 9, scale: 6 }),
  inLng: numeric('in_lng', { precision: 9, scale: 6 }),
  inDistanceM: integer('in_distance_m'),
  outLat: numeric('out_lat', { precision: 9, scale: 6 }),
  outLng: numeric('out_lng', { precision: 9, scale: 6 }),
  outDistanceM: integer('out_distance_m'),
  ...stamps,
}, (t) => [
  unique('attendance_employee_day_uq').on(t.employeeId, t.date),
  index('attendance_date_idx').on(t.date),
]);

/**
 * The link a customer opens to see a bill. Kept beside the invoice, not on it: an issued invoice
 * is a legal record that the database refuses to change.
 */
export const invoiceLinks = pgTable('invoice_links', {
  invoiceId: uuid('invoice_id').primaryKey().references(() => invoices.id),
  token: text('token').notNull().unique(),
  createdAt: ts('created_at').notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

/** A payment reminder that was sent: to whom, for how much, and what it said. */
export const paymentReminders = pgTable('payment_reminders', {
  id: uuid('id').primaryKey().defaultRandom(),
  partyId: uuid('party_id').notNull().references(() => parties.id),
  amount: money('amount').notNull(),
  invoiceIds: uuid('invoice_ids').array().notNull(),
  message: text('message').notNull(),
  ...stamps,
}, (t) => [index('payment_reminders_party_idx').on(t.partyId, t.createdAt)]);

// ----------------------------------------------------------------------------
// Payroll: the month's salary worked out from the attendance register
// ----------------------------------------------------------------------------
export const payrollRunStatusEnum = pgEnum('payroll_run_status', ['draft', 'approved', 'paid']);

/** One month's salary for everyone. Draft: can be recalculated. Approved: in the books. Paid: the money has gone out. */
export const payrollRuns = pgTable('payroll_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** YYYY-MM */
  month: char('month', { length: 7 }).notNull().unique(),
  status: payrollRunStatusEnum('status').notNull().default('draft'),
  /** The date the salary expense is booked on: the last day of the month. */
  bookedOn: date('booked_on'),
  approvedBy: uuid('approved_by').references(() => users.id),
  approvedAt: ts('approved_at'),
  paidOn: date('paid_on'),
  paidFromAccountId: uuid('paid_from_account_id').references(() => accounts.id),
  paymentReference: text('payment_reference'),
  ...stamps,
});

/** One person's salary for one month, with everything it was worked out from kept as it was on the day. */
export const payslips = pgTable('payslips', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => payrollRuns.id, { onDelete: 'cascade' }),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  employeeName: text('employee_name').notNull(),
  employeeNo: text('employee_no').notNull(),
  department: text('department').notNull(),
  designation: text('designation').notNull(),
  bankAccountNo: text('bank_account_no'),
  bankIfsc: text('bank_ifsc'),
  monthlySalary: money('monthly_salary').notNull(),
  daysInMonth: integer('days_in_month').notNull(),
  paidDays: numeric('paid_days', { precision: 4, scale: 1 }).notNull(),
  present: integer('present').notNull().default(0),
  halfDays: integer('half_days').notNull().default(0),
  leaveDays: integer('leave_days').notNull().default(0),
  weeklyOff: integer('weekly_off').notNull().default(0),
  holidays: integer('holidays').notNull().default(0),
  absent: integer('absent').notNull().default(0),
  /** Working days nobody marked in the register: not paid, and shown so they can be completed first. */
  notMarked: integer('not_marked').notNull().default(0),
  grossEarned: money('gross_earned').notNull(),
  basicEarned: money('basic_earned').notNull(),
  allowanceEarned: money('allowance_earned').notNull(),
  pfEmployee: money('pf_employee').notNull().default('0'),
  pfEmployer: money('pf_employer').notNull().default('0'),
  esicEmployee: money('esic_employee').notNull().default('0'),
  esicEmployer: money('esic_employer').notNull().default('0'),
  pt: money('pt').notNull().default('0'),
  tds: money('tds').notNull().default('0'),
  advanceRecovery: money('advance_recovery').notNull().default('0'),
  otherEarning: money('other_earning').notNull().default('0'),
  otherDeduction: money('other_deduction').notNull().default('0'),
  netPay: money('net_pay').notNull(),
  note: text('note'),
  /** The key of the link the person opens to see this payslip; made the first time it is sent. */
  token: text('token').unique(),
  ...stamps,
}, (t) => [unique('payslips_run_employee_uq').on(t.runId, t.employeeId)]);

/** Money given to someone ahead of their salary, taken back out of later salaries a set amount a month. */
export const salaryAdvances = pgTable('salary_advances', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  givenOn: date('given_on').notNull(),
  amount: money('amount').notNull(),
  monthlyRecovery: money('monthly_recovery').notNull(),
  paidFromAccountId: uuid('paid_from_account_id').notNull().references(() => accounts.id),
  note: text('note'),
  cancelledAt: ts('cancelled_at'),
  ...stamps,
}, (t) => [
  index('salary_advances_employee_idx').on(t.employeeId),
  check('salary_advances_amount_chk', sql`${t.amount} > 0 and ${t.monthlyRecovery} > 0`),
]);

export const advanceRecoveries = pgTable('advance_recoveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  advanceId: uuid('advance_id').notNull().references(() => salaryAdvances.id),
  payslipId: uuid('payslip_id').notNull().references(() => payslips.id, { onDelete: 'cascade' }),
  amount: money('amount').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [index('advance_recoveries_advance_idx').on(t.advanceId)]);

export const leaveRequestStatusEnum = pgEnum('leave_request_status', ['pending', 'approved', 'rejected', 'cancelled']);

/** Leave someone has asked for. Once approved, the days go into the attendance register as Leave. */
export const leaveRequests = pgTable('leave_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeId: uuid('employee_id').notNull().references(() => employees.id),
  fromDate: date('from_date').notNull(),
  toDate: date('to_date').notNull(),
  /** Working days in the span when it was asked for (weekly offs left out). */
  days: integer('days').notNull(),
  reason: text('reason').notNull(),
  status: leaveRequestStatusEnum('status').notNull().default('pending'),
  decidedBy: uuid('decided_by').references(() => users.id),
  decidedAt: ts('decided_at'),
  decisionNote: text('decision_note'),
  ...stamps,
}, (t) => [
  index('leave_requests_employee_idx').on(t.employeeId),
  index('leave_requests_status_idx').on(t.status),
  check('leave_requests_span_chk', sql`${t.toDate} >= ${t.fromDate}`),
]);

// ----------------------------------------------------------------------------
// Operations (PRD 7.14, Tier 3): recurring tasks with checklists, assets and their maintenance
// ----------------------------------------------------------------------------
export const taskFrequencyEnum = pgEnum('task_frequency', TASK_FREQUENCIES);
export const taskStatusEnum = pgEnum('task_status', TASK_STATUSES);
export const assetStatusEnum = pgEnum('asset_status', ASSET_STATUSES);
export const intervalUnitEnum = pgEnum('interval_unit', INTERVAL_UNITS);

export const taskTemplates = pgTable('task_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  description: text('description'),
  frequency: taskFrequencyEnum('frequency').notNull(),
  /** Daily and weekly: the days it runs on, 0 = Sunday ... 6 = Saturday. */
  weekdays: smallint('weekdays').array().notNull().default(sql`'{}'::smallint[]`),
  /** Monthly: the day of the month; 29 to 31 fall on the last day of a shorter month. */
  monthDay: smallint('month_day'),
  assigneeId: uuid('assignee_id').notNull().references(() => users.id),
  checklist: jsonb('checklist').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  /** Finish-by time on the day; null means any time that day. */
  dueTime: time('due_time'),
  startDate: date('start_date').notNull(),
  active: boolean('active').notNull().default(true),
  ...stamps,
}, (t) => [
  check('task_templates_weekdays_chk',
    sql`${t.weekdays} <@ array[0,1,2,3,4,5,6]::smallint[] and (${t.frequency} not in ('daily','weekly') or cardinality(${t.weekdays}) > 0)`),
  check('task_templates_month_day_chk', sql`${t.frequency} <> 'monthly' or ${t.monthDay} between 1 and 31`),
]);

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  templateId: uuid('template_id').references(() => taskTemplates.id),
  /** The day of the schedule this task was created for. Null for tasks raised by hand. */
  scheduledFor: date('scheduled_for'),
  /** Set for tasks that belong to a project. */
  projectId: uuid('project_id').references((): AnyPgColumn => projects.id),
  title: text('title').notNull(),
  description: text('description'),
  assigneeId: uuid('assignee_id').notNull().references(() => users.id),
  /** When work is planned to begin (project tasks); null means whenever. */
  startDate: date('start_date'),
  /** The deadline: this day, by `dueTime` if one is set, otherwise by the end of the day. */
  dueDate: date('due_date').notNull(),
  dueTime: time('due_time'),
  status: taskStatusEnum('status').notNull().default('open'),
  /**
   * When work on it began (moved to "In progress" on the board). An open task with this set is in
   * progress, without it still to do; a closed task keeps it as a record. Kept apart from `status`
   * so that everything counting open and late tasks counts in-progress ones too.
   */
  startedAt: ts('started_at'),
  checklist: jsonb('checklist').$type<{ text: string; done: boolean }[]>().notNull().default(sql`'[]'::jsonb`),
  completedAt: ts('completed_at'),
  completedBy: uuid('completed_by').references(() => users.id),
  note: text('note'),
  ...stamps,
}, (t) => [
  // The schedule creates each day's task exactly once, however often it is run.
  unique('tasks_template_day_uq').on(t.templateId, t.scheduledFor),
  index('tasks_assignee_idx').on(t.assigneeId, t.status, t.dueDate),
  index('tasks_due_idx').on(t.dueDate),
  index('tasks_project_idx').on(t.projectId),
  check('tasks_closed_chk', sql`(${t.status} = 'open') = (${t.completedAt} is null)`),
  check('tasks_start_chk', sql`${t.startDate} is null or ${t.startDate} <= ${t.dueDate}`),
]);

// ----------------------------------------------------------------------------
// Projects and resource allocation (Operations)
// ----------------------------------------------------------------------------
export const projectStatusEnum = pgEnum('project_status', PROJECT_STATUSES);

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectNo: text('project_no').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  /** The person answerable for the project. */
  ownerId: uuid('owner_id').notNull().references(() => users.id),
  startDate: date('start_date').notNull(),
  deadline: date('deadline'),
  status: projectStatusEnum('status').notNull().default('planned'),
  completedOn: date('completed_on'),
  ...stamps,
}, (t) => [
  check('projects_deadline_chk', sql`${t.deadline} is null or ${t.deadline} >= ${t.startDate}`),
  check('projects_done_chk', sql`(${t.status} = 'done') = (${t.completedOn} is not null)`),
]);

/**
 * Who and what is committed to which work, for which dates, and for how much of their time.
 * A resource is a person (employee) or a machine or vehicle (asset). The work is a project,
 * or a short label for anything that is not a project ("Showroom duty", "Diwali stall").
 */
export const allocations = pgTable('allocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => projects.id),
  label: text('label'),
  employeeId: uuid('employee_id').references(() => employees.id),
  assetId: uuid('asset_id').references(() => assets.id),
  fromDate: date('from_date').notNull(),
  toDate: date('to_date').notNull(),
  /** Share of the resource's time, 1 to 100. */
  percent: integer('percent').notNull().default(100),
  role: text('role'),
  notes: text('notes'),
  ...stamps,
}, (t) => [
  index('allocations_employee_idx').on(t.employeeId, t.fromDate),
  index('allocations_asset_idx').on(t.assetId, t.fromDate),
  index('allocations_project_idx').on(t.projectId),
  check('allocations_one_resource_chk', sql`(${t.employeeId} is not null) <> (${t.assetId} is not null)`),
  check('allocations_work_chk', sql`${t.projectId} is not null or ${t.label} is not null`),
  check('allocations_dates_chk', sql`${t.toDate} >= ${t.fromDate}`),
  check('allocations_percent_chk', sql`${t.percent} between 1 and 100`),
]);

export const assets = pgTable('assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  assetNo: text('asset_no').notNull().unique(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  location: text('location'),
  serialNo: text('serial_no'),
  purchaseDate: date('purchase_date'),
  purchaseCost: money('purchase_cost'),
  status: assetStatusEnum('status').notNull().default('in_use'),
  notes: text('notes'),
  ...stamps,
});

export const maintenanceSchedules = pgTable('maintenance_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  assetId: uuid('asset_id').notNull().references(() => assets.id),
  title: text('title').notNull(),
  intervalCount: integer('interval_count').notNull(),
  intervalUnit: intervalUnitEnum('interval_unit').notNull(),
  nextDueOn: date('next_due_on').notNull(),
  lastDoneOn: date('last_done_on'),
  assigneeId: uuid('assignee_id').references(() => users.id),
  /** Starts showing as "due soon" this many days ahead. */
  remindDaysBefore: integer('remind_days_before').notNull().default(7),
  instructions: text('instructions'),
  active: boolean('active').notNull().default(true),
  ...stamps,
}, (t) => [
  index('maintenance_schedules_due_idx').on(t.nextDueOn),
  index('maintenance_schedules_asset_idx').on(t.assetId),
  check('maintenance_schedules_interval_chk', sql`${t.intervalCount} > 0 and ${t.remindDaysBefore} >= 0`),
]);

export const maintenanceLogs = pgTable('maintenance_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  assetId: uuid('asset_id').notNull().references(() => assets.id),
  /** Null for a repair or service that was not on any schedule. */
  scheduleId: uuid('schedule_id').references(() => maintenanceSchedules.id),
  doneOn: date('done_on').notNull(),
  doneBy: text('done_by'),
  cost: money('cost'),
  notes: text('notes'),
  /** What the schedule's next due date became because of this entry. */
  nextDueOn: date('next_due_on'),
  ...stamps,
}, (t) => [index('maintenance_logs_asset_idx').on(t.assetId)]);
