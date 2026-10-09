import { sql } from 'drizzle-orm';
import {
  bigint, bigserial, boolean, char, check, date, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp,
  unique, uniqueIndex, uuid, type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  ACCOUNT_TYPES, ADJUSTMENT_STATUSES, BILL_DOC_TYPES, BILL_STATUSES, CHANNELS, GRN_STATUSES, INVOICE_DOC_TYPES,
  INVOICE_STATUSES, ITEM_TYPES, LEAD_ACTIVITY_TYPES, LEAD_STAGES, LOCATION_TYPES, MOVEMENT_TYPES, ORDER_STATUSES,
  PARTY_TYPES, PAYMENT_DIRECTIONS, PAYMENT_MODES, PO_STATUSES, ROLES,
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
}, (t) => [check('stock_transfer_lines_qty_pos', sql`${t.qty} > 0`)]);

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
});

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
});

export const deliveryLines = pgTable('delivery_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  deliveryId: uuid('delivery_id').notNull().references(() => deliveries.id),
  orderLineId: uuid('order_line_id').notNull().references(() => salesOrderLines.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  qty: qty('qty').notNull(),
  /** Valuation rate at the moment of delivery (drives COGS). */
  unitCost: money('unit_cost').notNull(),
}, (t) => [check('delivery_lines_qty_pos', sql`${t.qty} > 0`)]);

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
}, (t) => [index('invoice_lines_invoice_idx').on(t.invoiceId)]);

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
});

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
}, (t) => [check('pol_qty_pos', sql`${t.qty} > 0`)]);

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
  status: billStatusEnum('status').notNull().default('posted'),
  notes: text('notes'),
  ...stamps,
}, (t) => [
  unique('purchase_bills_no_fy_uq').on(t.docType, t.billNo, t.fy),
  uniqueIndex('purchase_bills_supplier_inv_uq').on(t.supplierId, t.supplierInvoiceNo)
    .where(sql`${t.docType} = 'bill' and ${t.status} = 'posted' and ${t.supplierInvoiceNo} is not null`),
  index('purchase_bills_supplier_idx').on(t.supplierId),
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
});

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
});

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
});

export const purchaseReturnLines = pgTable('purchase_return_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  returnId: uuid('return_id').notNull().references(() => purchaseReturns.id),
  grnLineId: uuid('grn_line_id').notNull().references(() => goodsReceiptLines.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  qty: qty('qty').notNull(),
  rate: money('rate').notNull(),
});

// ----------------------------------------------------------------------------
// 8.9 payments
// ----------------------------------------------------------------------------
export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  paymentNo: text('payment_no').notNull().unique(),
  direction: paymentDirectionEnum('direction').notNull(),
  partyId: uuid('party_id').references(() => parties.id),
  mode: paymentModeEnum('mode').notNull(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  amount: money('amount').notNull(),
  reference: text('reference'),
  paidOn: date('paid_on').notNull(),
  status: postedStatusEnum('status').notNull().default('posted'),
  notes: text('notes'),
  ...stamps,
}, (t) => [
  index('payments_party_idx').on(t.partyId),
  check('payments_amount_pos', sql`${t.amount} > 0`),
]);

export const paymentAllocations = pgTable('payment_allocations', {
  id: uuid('id').primaryKey().defaultRandom(),
  paymentId: uuid('payment_id').notNull().references(() => payments.id),
  invoiceId: uuid('invoice_id').references(() => invoices.id),
  purchaseBillId: uuid('purchase_bill_id').references(() => purchaseBills.id),
  amount: money('amount').notNull(),
  ...stamps,
}, (t) => [
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
  attachmentUrl: text('attachment_url'),
  notes: text('notes'),
  status: postedStatusEnum('status').notNull().default('posted'),
  ...stamps,
}, (t) => [check('expenses_amount_pos', sql`${t.amount} > 0`)]);

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
  matchedJournalLineId: bigint('matched_journal_line_id', { mode: 'number' }).references(() => journalLines.id),
  matchedAt: ts('matched_at'),
  matchedBy: uuid('matched_by').references(() => users.id),
  ignoreReason: text('ignore_reason'),
  ...stamps,
}, (t) => [
  unique('bank_statement_lines_hash_uq').on(t.accountId, t.lineHash),
  // A book entry explains at most one statement line.
  uniqueIndex('bank_statement_lines_match_uq').on(t.matchedJournalLineId).where(sql`${t.matchedJournalLineId} is not null`),
  index('bank_statement_lines_account_date_idx').on(t.accountId, t.txnDate),
  check('bank_statement_lines_amount_nonzero', sql`${t.amount} <> 0`),
  check('bank_statement_lines_match_chk', sql`(${t.status} = 'matched') = (${t.matchedJournalLineId} is not null)`),
]);

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
  processedAt: ts('processed_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [unique('channel_events_uq').on(t.channel, t.eventType, t.externalId)]);
