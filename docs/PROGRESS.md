# RadCore — progress tracker

The single place that records **what has been built, what has not, and why things were done
the way they were**. Update it with every change (add a line to the change log at the bottom).

- Source of requirements: `PRD: Radboards ERP` (v1 draft, 7 Oct 2026).
- Repository: https://github.com/sarthakradboards-hash/radcore-erp (private).
- Priority set by Sarthak (8 Oct 2026): **backend correctness first, frontend kept simple.**

## 1. Where things stand (9 Oct 2026)

**The founder approved the proposed structure and all five decisions on 9 Oct 2026** (WhatsApp reply to the report: "Good report. Yes proceed"). The project is now in phase 2: go live.

| Area | State |
| --- | --- |
| Backend (API, database, posting engine) | MVP **and** most of V1.1 built and tested |
| Frontend | Simple working screens for every built flow (36 screens, no charts, plain styling) |
| Automated tests | 78 passing: 17 shared, 53 API integration (hand-checked figures), 8 simultaneous-request tests. The API tests pass on both the in-memory database and real PostgreSQL |
| Integrations (Meta, Google, Shopify, GSP) | Not built — data model and idempotency keys are ready |
| Vyapar migration | Not built — needs sample export files |
| Deployment / hosting / backups | Packaged for one server (Docker, HTTPS, daily backups) and verified in CI. **Not deployed**: needs a server and a domain |

Legend: ✅ built and tested · 🟡 partly built · ⬜ not built yet

## 2. PRD section by section

### 6. Lifecycles
| Item | State | Notes |
| --- | --- | --- |
| Lead stage machine (New → Contacted → Interested → Meeting Booked → Converted / Lost) | ✅ | Fixed transitions in `packages/shared/src/constants.ts`; DB checks for lost reason and follow-up date |
| Sales order Draft → Confirmed → Delivered → Invoiced / Cancelled | ✅ | Status derived from delivered/invoiced quantities; partial deliveries and part-invoicing work |
| Invoice Draft → Issued (immutable) / Cancelled; payment status computed | ✅ | Immutability enforced by DB trigger as well |
| Purchase → stock (PO sent → bill → received → QC → inwarded / rejected → returned) | ✅ | |

### 7. Functional requirements
| § | Item | State | Notes |
| --- | --- | --- | --- |
| 7.1 | Source list, source_detail, manual capture | ✅ | |
| 7.1 | Dedupe on normalised phone | ✅ | Repeat enquiry becomes an activity on the existing lead |
| 7.1 | Owner + first follow-up on every lead | ✅ | Explicit → source rule → the sales/store user who took it → round-robin over sales users |
| 7.1 | Public form per campaign (QR / short link / website) | 🟡 | Token link + rate limit + honeypot. **No captcha yet.** QR image not generated (print the link with any QR tool) |
| 7.1 | Meta lead ads / Google Ads webhooks | ⬜ | V1.2. `leads.external_ref` (unique) and `channel_events` are ready |
| 7.2 | Walk-in tablet form with repeat-customer lookup | ✅ | "Buying now" converts and jumps to quick bill. Offline queue (nice-to-have) not built |
| 7.3 | Pipeline: kanban, list, owner, activity log, WhatsApp link, lost reasons, saved views | ✅ | Kanban is read-only columns (stage is changed on the lead page; no drag-and-drop) |
| 7.3 | Conversion by source and owner | ✅ | On the dashboards |
| 7.4 | Convert → party (links both ways) | ✅ | Reuses the party that already has the phone |
| 7.4 | Quick bill: order + invoice + stock + payment + journal in **one transaction** | ✅ | Split payments; unpaid remainder = credit (needs a named party) |
| 7.4 | Invoice PDF (A4 / thermal), print, share on WhatsApp | 🟡 | Printed/saved as PDF from the browser (A4 and thermal layouts). WhatsApp shares a text summary, not the PDF file. No server-side PDF yet |
| 7.5 | Channel on every order, one stock for all channels | ✅ | |
| 7.5 | Dealers: price list, credit limit, terms, quote → order → delivery → invoice, outstanding | ✅ | Credit-limit block with override by Accounts/owner |
| 7.5 | Shopify (orders, SKU map, stock push) | ⬜ | V1.2. `channel_item_map`, `channel_events`, unique `(channel, external_order_id)` exist |
| 7.5 | Amazon / Flipkart | ⬜ | V1.3 |
| 7.6 | Item master, locations, append-only stock ledger | ✅ | Image upload is API-only (URL), no file storage yet |
| 7.6 | Transfers, adjustments, physical counts (reason + approval) | ✅ | Admin or owner approves; transfers need a reason but no approval |
| 7.6 | Valuation | 🟡 | Moving average only. FIFO not built (CA decision pending) |
| 7.6 | Low-stock view, availability for sales, raw-material stock | ✅ | |
| 7.7 | PO → supplier bill → goods receipt with QC → supplier return + debit note, payables | ✅ | Bill/receipt mismatches are flagged on the bill |
| 7.8 | Chart of accounts (seeded, editable), FY April–March | ✅ | |
| 7.8 | Balanced double entry for every document | ✅ | Posting service + deferred DB trigger |
| 7.8 | Payments in/out with allocation, advances, part-payments | ✅ | |
| 7.8 | Expenses with input GST | 🟡 | Bill photo is a link (URL); no file upload yet |
| 7.8 | Credit notes (stock back in) and debit notes (stock out) | ✅ | |
| 7.8 | Multiple cash/bank accounts | ✅ | |
| 7.8 | Bank statement import (CSV) and reconciliation | ⬜ | V1.1 item still open |
| 7.8 | Immutable issued documents, period lock | ✅ | |
| 7.8 | Opening balances | 🟡 | By manual journal (parties/accounts) and opening-stock entry. No import tool |
| 7.8 | Year-end close voucher | ⬜ | Not needed for reports (balance sheet shows profit to date); needed before the first year end |
| 7.8 | Reports: day book, party ledger, receivables/payables ageing, cash/bank book, trial balance, P&L, balance sheet, stock valuation | ✅ | Plus a "health check" (books vs stock ledger) |
| 7.9 | GSTIN format + checksum, state from GSTIN | ✅ | |
| 7.9 | HSN/SAC + rate on every item; place-of-supply rule in one tested function | ✅ | `packages/shared/src/gst.ts` |
| 7.9 | Invoice numbering (consecutive per FY, ≤ 16 chars, separate series) | ✅ | `INV/26-27/00001`, `CN/…`, `DN/…` |
| 7.9 | Tax invoice content (B2B and B2C) | ✅ | Total in words, HSN summary, tax split |
| 7.9 | GSTR-1 (B2B, B2CL, B2CS, CDNR, CDNUR, HSN, documents issued) | 🟡 | JSON + CSV per section. **Not yet the portal's exact upload file** — CA must check the first filing |
| 7.9 | GSTR-3B summary | ✅ | Ties to the GST ledger balances (tested) |
| 7.9 | E-invoice / e-way bill | ⬜ | V1.3; `irn`, `eway_bill_no` columns exist |
| 7.10 | Sales, marketing, accounts dashboards (live, date range) | ✅ | Numbers and tables, no charts. Click-through to lists is partial |
| 7.10 | Cost per lead (ad spend) | ⬜ | V1.2 |
| 7.11 | Export every list/report | 🟡 | CSV everywhere (`?format=csv`). Excel/PDF export not built |
| 7.11 | Print formats | 🟡 | Tax invoice + credit note (A4, thermal). Quote, PO and purchase bill print as plain pages. Delivery challan and payment receipt layouts not built |
| 7.12 | Vyapar migration, dry run, parallel run | ⬜ | Needs sample Vyapar exports |
| 7.13 | Company profile, users, roles, masters, period lock | ✅ | |
| 7.13 | Permission matrix | 🟡 | Enforced on every route, but fixed in code (`PERMISSIONS`), not editable on screen |
| 7.13 | Numbering series, integration settings | 🟡 | Series are visible, not editable. No integration settings yet |
| 7.14 | HR (Tier 2), Operations (Tier 3) | ⬜ | V2 |

### 9. Non-functional requirements
| Item | State | Notes |
| --- | --- | --- |
| Auth + roles from day one | ✅ | HttpOnly SameSite cookie, bcrypt, session revoked on deactivate/password change, login rate limit, cross-site POSTs refused |
| One transaction per multi-step action; double-entry invariant; gap-free numbering; immutability | ✅ | All covered by tests |
| Idempotent integrations | 🟡 | Keys and tables exist and lead capture is idempotent; the webhook endpoints themselves are not built |
| Audit trail | ✅ | Append-only `audit_log` |
| HTTPS, webhook signatures, secrets encrypted at rest, captcha | ⬜ | Deployment / integration work |
| Backups, Indian-region hosting, retention | ⬜ | Hosting decision pending |
| Performance targets (50,000 rows < 1 s, bill < 2 s) | ⬜ | Not load-tested. Indexes are in place |
| Locale (INR grouping, DD-MM-YYYY, IST, FY Apr–Mar) | ✅ | |
| Automated tests (GST split, rounding, posting, stock, idempotency) | ✅ | |

## 3. Decisions

### Approved by the founder (9 Oct 2026)

From the report sent to him (https://claude.ai/code/artifact/8780229e-2f57-4cd3-896c-ac4a301b15db).
His reply was a blanket "Yes proceed", not an item-by-item answer.

| # | Decision | Approved route |
| --- | --- | --- |
| 1 | Accounts: inside the ERP, or stay on Vyapar | Accounts moves into the ERP. Vyapar runs beside it for the first month and is switched off once the ERP figures match it |
| 2 | How we build | Our own lean app, following ERPNext's document flow (not installing a full open-source ERP) |
| 3 | Phase 1 scope | Marketing, sales, accounts, inventory and stores now. HR hiring and operations later. Attendance, the service app and R&D stay outside |
| 4 | Walk-in sales | Store staff issue the GST invoice on the spot from the tablet. Only accounts can cancel an invoice or raise a credit note |
| 5 | Where it runs | A managed cloud server in an Indian region with automatic daily backups. Sarthak owes the founder cost options before go-live |

### Taken while building (not individually confirmed)

These were open in the PRD or not specified. Each is easy to revisit now, harder after go-live.
Items 6 and 7 below are covered by the approval above.

**Accounting**
1. **Perpetual inventory accounting.** Inward: Dr Stock in Hand / Cr Goods Received Not Billed.
   Bill: Dr GRNI + Dr Input GST / Cr Creditors. Delivery: Dr Cost of Goods Sold / Cr Stock.
   This is what makes P&L and stock value correct without a month-end entry.
2. **Moving-average valuation** (per item, across locations). FIFO is not built.
3. **Invoice total rounded to the nearest rupee**, difference posted to a Round Off account.
4. **GSTR-1 B2C-large threshold** is set to ₹1,00,000 (`B2CL_THRESHOLD` in `apps/api/src/modules/gst.ts`).
5. Input GST on an expense is only accepted with the vendor's GSTIN.

**How it behaves**
6. **A walk-in invoice is issued immediately**, not held for Accounts to review (PRD open question).
7. **Retail prices include GST; dealer prices exclude it** (a switch on each price list).
8. **A repeat enquiry never creates a second lead.** If the old lead was Lost it reopens to
   Contacted. ⚠️ If the person is already a customer, the new enquiry is only logged as an
   activity on their old (Converted) lead — it does **not** reappear in the pipeline. Say if
   repeat customers should get a fresh lead instead.
9. A **quote is a Draft sales order** (no separate quote document).
10. Store sales take stock from the **Showroom**; dealer and other orders from **Stores**
    (can be changed per delivery). Rejected stock can never be sold.
11. **Receiving more than the PO quantity is blocked**, and goods must be billed against a PO line.
12. **Rejects are returned against the supplier's bill**, so the bill must be recorded before
    the return (the PRD says the bill arrives before or with the goods).
13. A credit note larger than what is still owed leaves the customer **in credit**; it is
    refunded with a payment out. It cannot yet be set against another invoice.
14. **Cancelling an invoice** keeps its number, reverses its entries, and is refused if a
    credit note exists. Receipts taken only for that invoice can be cancelled with it.
15. One party row per role; the same phone can be both a customer and a supplier.
16. Sessions last 14 days; passwords need 8+ characters.

**Technical**
17. ORM is **Drizzle**. Local development and tests use **PGlite** (PostgreSQL compiled to
    run inside Node), so no database install is needed; production uses real PostgreSQL via
    `DATABASE_URL`. Same SQL migrations on both.
18. Not used yet from the PRD's suggested stack, because nothing needs them so far: Redis /
    BullMQ, S3 storage, headless-Chromium PDFs, Tailwind / shadcn / TanStack. Zod schemas
    live in the API and are not shared with the frontend yet.
19. API JSON is snake_case throughout (same names as the PRD's columns).

## 4. Known gaps and caveats

- No accountant has reviewed the posting rules or GST exports. They follow standard practice
  and are internally consistent (tested). Sarthak decided on 8 Oct 2026 that this is not a
  go-live condition; the month running beside Vyapar is the check.
- Backups made by `compose.prod.yml` are daily dumps on the same server as the database, with
  no point-in-time recovery. They need an off-server copy (provider snapshots or object
  storage) once the server exists.
- The production images are built and started in CI, but the HTTPS proxy (Caddy) can only be
  tried on a real server with a real domain.
- If a supplier's bill rate differs from the PO rate, the difference stays in *Goods Received
  Not Billed* and is flagged on the bill for Accounts to journal.
- Dev-only advisory: `drizzle-kit` (migration generator) bundles an old `esbuild`
  (4 moderate `npm audit` findings). It is not part of the running app. Production
  dependencies audit clean.
- The frontend has no automated tests; it was checked by hand against the demo data.

## 5. How it was verified

- `npm test` — 69 tests. `apps/api/test/trade.test.ts` runs the full story (buy → QC →
  return → transfer → count → quick bill → dealer order with partial delivery → receipts →
  credit note → cancel → expenses → period lock → GST returns → dashboards) and asserts
  hand-calculated numbers, that the trial balance and balance sheet balance, and that the
  Stock ledger account equals the stock valuation after every stage.
- A failed quick bill is tested to leave no rows behind and not consume an invoice number.
- Direct database tampering (editing an issued invoice, deleting stock rows, unbalanced
  entries, posting into a locked period) is tested to be rejected by the database itself.
- **Real PostgreSQL (9 Oct 2026).** The whole API suite also runs against a real PostgreSQL
  server (`TEST_DATABASE_URL`), locally on PostgreSQL 18 and in CI on PostgreSQL 16.
- **Simultaneous requests (9 Oct 2026).** `apps/api/test/concurrency.test.ts` fires requests at
  the same instant on real PostgreSQL: 20 bills get 20 consecutive invoice numbers; 12 buyers
  for the last 5 units give exactly 5 sales and stock never goes negative; five receipts for
  one invoice settle it once; an adjustment approved twice is applied once; mixed sales,
  transfers and expenses do not deadlock. Repeated six times locally without a failure.
  This found and fixed one real bug: the same enquiry submitted several times at once created
  several leads (now one, using a per-phone lock).
- Manual click-through on demo data (8 Oct 2026): sign-in, quick bill with barcode scan →
  printed invoice, pipeline, stock, PO → bill → receipt → QC with reject → supplier return,
  reports, dashboards, setup.

## 6. Next steps (phase 2: go live)

Waiting on Sarthak / the founder:
1. **A server and a domain.** Pick the hosting option (cost options owed to the founder), create
   the account, point a domain at it. Then deployment is the two commands in the README.
2. **Vyapar exports** (parties with GSTIN and balances, items with HSN and prices, stock per
   location, unpaid invoices and bills) so the import can be built against the real files.
3. **Who uses it**: names and roles, plus the real company profile (GSTIN, address, bank
   details, logo) and how dealer prices and credit terms work.

Can be built without waiting:
4. Import tool for opening data with a dry-run validation report (PRD 7.12).
5. A comparison report for the month beside Vyapar (sales, tax, stock, balances per day).
6. Print layouts: delivery challan, payment receipt, quote, PO.
7. Bank statement import and reconciliation; year-end close; portal-format GSTR-1 file.

Later phases (as approved): Shopify orders and Meta / Google leads coming in automatically,
Amazon and Flipkart, then HR hiring and operations tasks.

## 7. Change log

| Date | Change |
| --- | --- |
| 2026-10-08 | Repo created. Shared package (money, GST, phone, FY, state machines, permissions). |
| 2026-10-08 | API: schema (45 tables), DB triggers and views, auth/RBAC, audit, numbering, posting service, stock ledger. |
| 2026-10-08 | API modules: admin/masters, items, parties, leads, sales (orders, delivery, invoice, quick bill, credit note, cancel), payments, purchasing (PO, GRN + QC, bills, supplier return), inventory, accounting (expenses, journals, reports), GST, dashboards. 69 tests. |
| 2026-10-08 | API responses unified to snake_case and ISO-8601 timestamps; stored links restricted to http/https. |
| 2026-10-08 | Web app: 36 simple screens covering every built flow; demo mode (`npm run demo`). |
| 2026-10-08 | Dependencies: drizzle-orm 0.45.3 (SQL-identifier advisory), vitest 5, concurrently 10; CI workflow added. |
| 2026-10-08 | Founder approval document prepared from the two founder calls of 7 Oct: https://claude.ai/code/artifact/8780229e-2f57-4cd3-896c-ac4a301b15db. Five decisions are with the founder: accounts in the ERP or stay on Vyapar (on the second call he asked whether the ERP could sit on top of Vyapar; Vyapar offers no public API), own build vs a full open-source ERP, phase 1 scope, walk-in invoice on the spot, hosting. Section 3 above stays provisional until he answers. |
| 2026-10-08 | Decision (Sarthak): a CA check is not part of the plan or a go-live condition; the job is to build the app for the agreed flow. Removed from the founder document. The month running beside Vyapar stays as the check before Vyapar is switched off. |
| 2026-10-09 | **Founder approved** the report and its five decisions ("Good report. Yes proceed"). Phase 2 (go live) started. |
| 2026-10-09 | API test suite now also runs on real PostgreSQL. New simultaneous-request tests (8). Fixed: the same enquiry submitted several times at once created several leads. "Today" in overdue and ageing figures is now India time whatever timezone the database server uses. |
| 2026-10-09 | Deployment packaging: `Dockerfile`, `compose.prod.yml` (PostgreSQL 16, API, web, Caddy HTTPS, daily backups with 30-day retention), `.env.production.example`, README runbook. CI now runs the API tests on PostgreSQL and builds and starts the production stack. |
