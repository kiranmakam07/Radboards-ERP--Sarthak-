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
| Frontend | Simple working screens for every built flow (79 screens, plain styling), with charts on the dashboards, a "what is waiting where" picture on the home screen and progress steps on documents |
| Automated tests | 360 passing: 31 shared, 321 API integration (hand-checked figures; 21 of them are one story followed through every section), 8 simultaneous-request tests. The API tests pass on both the in-memory database and real PostgreSQL |
| Lead capture (Meta lead ads, Google Ads lead forms, WhatsApp, website) | Receiving side built and tested with the payloads those services send. **Not connected to real accounts yet** (needs the Meta app, the WhatsApp Cloud API number and the Google Ads form, at go-live) |
| Other integrations (Shopify, Amazon, Flipkart, GSP) | Not built — data model and idempotency keys are ready |
| Vyapar migration | Not built — needs sample export files |
| Deployment / hosting / backups | Packaged for one server (Docker, HTTPS, daily backups) and verified in CI. A **review copy** can be started with sample data and its own sign-ins (`SEED_DEMO_DATA=true`, see README). **Not deployed**: needs a server and a domain |

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
| 7.1 | Public form per campaign (QR / short link / website) | ✅ | Token link + rate limit + hidden trap field. The QR code is drawn on the Campaign links screen, to print or save. An "I am a person" check (Cloudflare Turnstile) switches on when its two keys are set on the server; without them the form runs as before |
| 7.1 | Meta lead ads / Google Ads webhooks | 🟡 | Built: `POST /api/hooks/meta` (signature checked, lead read from the Graph API), `POST /api/hooks/google-ads` (key = a campaign link's key; test leads create nothing). Each delivery is stored first, repeats are recognised, and what cannot become a lead is kept with the reason and a retry. **Not yet tried against the real services** |
| 7.1 | WhatsApp enquiries | 🟡 | Built: `POST /api/hooks/whatsapp` (Cloud API). First message from a new number starts a lead; later messages go on its timeline; a Click-to-WhatsApp ad's name is kept. Receiving only: replies are sent by opening WhatsApp with a quick reply. Needs the business number on the Cloud API. Numbers outside India are set aside |
| 7.1 | Website / any form tool | ✅ | `POST /api/hooks/form/<campaign key>` takes JSON or an ordinary form post |
| 7.3 | Quick replies and one-tap contact (as in Privyr) | ✅ | Ready-made messages with the lead's details filled in; one tap opens WhatsApp with the message, logs the contact, moves New to Contacted and sets the next follow-up. "Leads waiting for me" on the home screen and My work |
| 7.3 | Lead sources screen | ✅ | Each source's address, whether it is connected, leads per source, and everything that arrived with its result |
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
| 7.6 | Item master, locations, append-only stock ledger | ✅ | Pictures are added and removed on the items screen |
| 7.6 | Transfers, adjustments, physical counts (reason + approval) | ✅ | Admin or owner approves; transfers need a reason but no approval |
| 7.6 | Valuation | 🟡 | Moving average only. FIFO not built (CA decision pending) |
| 7.6 | Low-stock view, availability for sales, raw-material stock | ✅ | |
| 7.7 | PO → supplier bill → goods receipt with QC → supplier return + debit note, payables | ✅ | Bill/receipt mismatches are flagged on the bill |
| 7.8 | Chart of accounts (seeded, editable), FY April–March | ✅ | |
| 7.8 | Balanced double entry for every document | ✅ | Posting service + deferred DB trigger |
| 7.8 | Payments in/out with allocation, advances, part-payments | ✅ | |
| 7.8 | Expenses with input GST | ✅ | The bill can be attached as a photo or PDF (or a link) |
| 7.8 | Credit notes (stock back in) and debit notes (stock out) | ✅ | A credit note on an already-paid invoice leaves the customer in credit; that credit can be set against another of their invoices (on the invoice page), in full or in part, and taken back. It cannot be used twice, on another customer, or after it was refunded in cash; the receipt and credit note behind used credit cannot be cancelled |
| 7.8 | Multiple cash/bank accounts | ✅ | |
| 7.8 | Bank statement import (CSV) and reconciliation | ✅ | Reads the usual Indian bank CSV layouts, skips rows already imported, matches automatically only when unambiguous, and can book the missing entry (expense, party receipt or payment, other account) from a statement line. One statement line can be matched to several book entries that add up to it (a card-machine payout covering a day's receipts); if the bank kept a fee, it is booked as an expense in the same step. Cancelling any entry in a match undoes the whole match |
| 7.8 | Immutable issued documents, period lock | ✅ | |
| 7.8 | Opening balances | 🟡 | By manual journal (parties/accounts) and opening-stock entry. No import tool |
| 7.8 | Year-end close | ✅ | Books & reports → Financial years. One entry on 31 March moves the year's income and expenses to Retained Earnings and locks the year; years close in order, only after they end; the latest closed year can be reopened. A closed year's own profit and loss still reads as it was |
| 7.8 | Reports: day book, party ledger, receivables/payables ageing, cash/bank book, trial balance, P&L, balance sheet, stock valuation | ✅ | Plus a "health check" (books vs stock ledger) |
| 7.9 | GSTIN format + checksum, state from GSTIN | ✅ | |
| 7.9 | HSN/SAC + rate on every item; place-of-supply rule in one tested function | ✅ | `packages/shared/src/gst.ts` |
| 7.9 | Invoice numbering (consecutive per FY, ≤ 16 chars, separate series) | ✅ | `INV/26-27/00001`, `CN/…`, `DN/…` |
| 7.9 | Tax invoice content (B2B and B2C) | ✅ | Total in words, HSN summary, tax split |
| 7.9 | GSTR-1 (B2B, B2CL, B2CS, CDNR, CDNUR, HSN, documents issued) | 🟡 | On screen, CSV and Excel per section, and **a file for the GST portal** (GST → "File for the GST portal"): the JSON layout of the portal's offline tool, with the HSN table in its two parts (B2B / B2C) as filed since 2025, portal unit codes and document codes. Tested to agree with the on-screen return and with GSTR-3B. **Not yet uploaded to the real portal**: the first real upload is the proof, and the layout was taken from published descriptions of the offline tool, not from GSTN's own schema file |
| 7.9 | GSTR-3B summary | ✅ | Ties to the GST ledger balances (tested) |
| 7.9 | E-invoice / e-way bill | ⬜ | V1.3; `irn`, `eway_bill_no` columns exist |
| 7.10 | Sales, marketing, accounts dashboards (live, date range) | ✅ | Charts with the figures on them and a table behind each ("Show as table"): sales and leads per day, sales by channel, leads by stage and source, top items and dealers, dealer outstanding against credit limit, walk-ins by hour, receivables by age, expenses by category. Click-through to lists is partial |
| 7.10 | Home screen: the business as a flow | ✅ | Enquiry → lead → quote → delivery → invoice → money in, and purchase order → QC → stock → bill, each step showing how many are waiting and linking to that list. Each role sees only its own steps |
| 7.10 | Cost per lead (ad spend) | ✅ | CRM → Ad spend: entries by source and, if wanted, by campaign. The marketing dashboard divides it by the leads of the same days: cost per lead and per conversion, by source and by campaign. A record for marketing only; the payment is still booked under Expenses |
| 7.10 | Stores dashboard and the owner's one-page summary | ✅ | Stores: stock value by location and kind, running low, orders with suppliers, waiting QC, goods in and out per day, fastest sellers, stock not moving for 90 days. Owner: sales, collections, profit, cash, receivables, payables, stock, GST, and what needs attention across customers, stores, people and operations. Both checked against the books in tests |
| 7.11 | Export every list/report | ✅ | Excel (`?format=xlsx`) and CSV on every list and report. The Excel files have real numbers and dates, and were opened with an independent Excel reader to check them. PDF is by printing from the browser |
| 7.11 | Print formats | ✅ | Tax invoice + credit note (A4, thermal), delivery challan, payment receipt / voucher, quotation / sales order, purchase order. The purchase bill is the supplier's own document and prints as a plain page |
| 7.12 | Vyapar migration, dry run, parallel run | ⬜ | Needs sample Vyapar exports |
| 7.13 | Company profile, users, roles, masters, period lock | ✅ | |
| 7.13 | **Masters** (founder, 13 Oct 2026): items, customers and dealers, suppliers, employees in one admin-only place | ✅ | Admin → Masters: the four lists on one screen with counts and when each was last changed, and **one Excel workbook with a sheet per master**. Only an admin can add or change an item or an employee, or change a customer or supplier; other roles read them. Staff can still add a new customer or supplier in the middle of their work, without a price list, credit limit or payment terms. HR still hires and records an exit. Each master has its own permission (`items:write`, `parties:manage`, `employees:manage`), so an admin can hand one of them to another role |
| 7.13 | Permission matrix | ✅ | Enforced on every route. Admin → Permissions shows who can do what and lets an admin tick or untick any role for any permission; changes take effect at once and are in the audit trail. The admin role always holds everything |
| 7.13 | Numbering series, integration settings | 🟡 | Series are visible, not editable. No integration settings yet |
| 7.14 | HR (Tier 2): openings, applicants → interview rounds → hired (creates the employee) or rejected, employees, attendance (daily register, CSV import, month summary), HR dashboard | ✅ | 20 API tests. Every screen checked in the browser on demo data. Resumes are attached as files (PDF or photo), open to HR and to whoever is taking the interview. The attendance import takes a plain CSV (employee number or phone, date, status, optional in/out times); the real export from the current attendance app has not been seen yet. Leave balances per leave year (entitled, taken, left). Staff clock in from the phone and ask for leave; payroll runs from the register (added 12 Oct 2026, see the change log) |
| 7.14 | Operations (Tier 3): routines (daily / weekly / monthly / when needed) with checklists that create each person's tasks, one-off tasks, "My work" for everyone, asset register, maintenance schedules that roll forward when the work is logged, operations dashboard | ✅ | 28 API tests with projects and allocation. Also: **projects** (owner, deadline, tasks with start and deadline, progress, timeline), **resource allocation** board (people and assets by week, double-booking flagged), **deadlines with a time** on every task. Every screen checked in the browser on demo data. Tasks are created the first time anyone opens a task screen each day (no background job needed). Reminders are in-app only: the home screen and My work (no WhatsApp yet). Maintenance cost is a record only; the expense itself is still entered under Expenses |

### 9. Non-functional requirements
| Item | State | Notes |
| --- | --- | --- |
| Auth + roles from day one | ✅ | HttpOnly SameSite cookie, bcrypt, session revoked on deactivate/password change, login rate limit, cross-site POSTs refused |
| One transaction per multi-step action; double-entry invariant; gap-free numbering; immutability | ✅ | All covered by tests |
| Idempotent integrations | 🟡 | Lead webhooks (Meta, Google, WhatsApp) store each delivery once and create each lead once (tested with repeat deliveries). Shopify and the marketplaces are not built |
| Audit trail | ✅ | Append-only `audit_log` |
| HTTPS, webhook signatures, secrets encrypted at rest, captcha | 🟡 | Meta and WhatsApp webhooks are signature-checked; Google's by key. The Meta secrets are server settings, never in the database or shown on screen. HTTPS comes with deployment. No captcha yet |
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

- `npm test` — 127 tests (21 shared, 106 API). `apps/api/test/trade.test.ts` runs the full story (buy → QC →
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
- HR and operations (9 Oct 2026): `hr.test.ts` and `ops.test.ts` cover the stage machine, one
  open application per person, hire creating exactly one employee, attendance rules and import,
  the schedule creating each task once (also when run three times at the same moment, and after
  a long gap), checklists, and maintenance dates rolling forward. An existing database was
  upgraded to the new migration on PostgreSQL 18. Screens clicked through on demo data.

## 6. Next steps

**Order of work (Sarthak, 9 Oct 2026): build the app out first; bring in the server, the real
Vyapar data and the user list only when deployment is close.** Do not ask for those before then.

Still to build in the app, in rough order:
7. Online orders, next steps: record the payment for an order already paid online (today its invoice shows as unpaid until accounts enter the gateway payout), connect the real Shopify store, check a real Amazon and a real Flipkart order report against the import, marketplace settlements (matching payouts and fees to the orders), stock levels pushed back to the channels.
8. CRM, once real leads flow (Sarthak: basic structure first, optimise later): approved WhatsApp templates for
   writing after the 24-hour window, delivered / read ticks, alerts that arrive when the app is closed (needs WhatsApp or
   push messages), tuning the lead score against real conversions.

For go-live, the CRM connections also need (not before then): a Meta developer app with the Page and
`leads_retrieval`, the WhatsApp Business number moved to the Cloud API, and the webhook set on each
Google Ads lead form. The steps are in the README under "Connecting lead sources".
8. HR and operations follow-ups, if wanted: WhatsApp reminders for tasks and maintenance.

HR and operations were built on 9 Oct 2026 (Sarthak: they are part of the app, not a later phase).

For go-live, when it is close (nothing needed before then):
- A server and a domain. Sarthak, 12 Oct 2026: it will be AWS, later. Deployment is then the two commands in the README.
- Vyapar exports (parties, items, stock, unpaid invoices and bills), for the opening data import.
- Who uses it (names and roles), the real company profile, dealer prices and credit terms.
- Then build: the opening-data import with a dry-run report, and the comparison report for the
  month beside Vyapar.

Hosting cost options (list prices read from the providers' pricing pages on 9 Oct 2026, in
USD, before taxes and currency conversion):

| Option | What you get | Monthly |
| --- | --- | --- |
| A. One server, everything on it (what `compose.prod.yml` runs and CI verifies) | 2 vCPU / 4 GB / 80 GB server. DigitalOcean Bangalore: $24 + daily server backups at 30% ($7.20). AWS Lightsail Mumbai: $24 + automatic snapshots at $0.05 per GB | about $31 (DigitalOcean); $24 plus snapshot storage (Lightsail) |
| B. Same server + managed PostgreSQL (the provider runs and backs up the database) | Adds DigitalOcean Managed PostgreSQL 1 GB at $15.15, or Lightsail Standard database 1 GB at $15 (that plan has no encryption at rest) | about $39 to $46 |

Sources: https://www.digitalocean.com/pricing/droplets , https://www.digitalocean.com/pricing/managed-databases ,
https://aws.amazon.com/lightsail/pricing/ . Option A is the recommended start: it is the setup
already tested, and moving the database to a managed service later is a configuration change.

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
| 2026-10-09 | Direction (Sarthak): build the whole app first; server, real data and user lists only when close to deployment. |
| 2026-10-09 | Printouts: delivery challan and payment receipt / voucher. |
| 2026-10-09 | Bank reconciliation: statement CSV import (idempotent), automatic and manual matching, booking the missing entry from a statement line, unreconciled figure on the accounts dashboard. Cancelling a reconciled entry puts its statement line back to unmatched. 15 new tests. |
| 2026-10-09 | HR and operations (Sarthak: part of the app before go-live). New roles `hr` and `operations`; migration `0003_hr_and_operations`; modules `hr.ts` and `ops.ts`; 37 new API tests (114 in all, passing in memory and on real PostgreSQL 18; upgrade of an existing database checked). Screens under HR, Operations and "My work"; demo data for both. |
| 2026-10-09 | HR and operations screens checked end to end on demo data (every form's values against the API, plus real clicks for ticking a checklist, finishing a task, saving attendance and logging maintenance). Small fixes from that pass: whole-number chart scales for counts, singular wording, clearer maintenance due text. CI green. |
| 2026-10-10 | Smaller gaps: QR code for campaign links; optional person-check on the public enquiry form (`TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET`); leave balances (company figure + per-person figure, pro-rated for joiners, counted from days marked Leave; migration `0010_leave_days`). |
| 2026-10-10 | Review copy on Vercel (Sarthak: "I have vercel"). The API can now run inside the web app as one deployment: `apps/api/src/serverless.ts` (per-request entry point), `apps/api/src/prepare.ts` (database update and sample data at build time), `apps/web/scripts/embed-api.mjs` + `vercel.json` (Singapore). Attached files can be kept in the database (`file_contents`, migration `0012`, `FILE_STORE=database`), with the size limit shown on the form. Checked on this machine against real PostgreSQL: the Vercel-style build, sign-in, lists, Excel, attachments, the public form and the website hook. The server setup is unchanged. |
| 2026-10-13 | **The story: how data flows from section to section** (Sarthak, on seeing the system map: "I didn't want a system map. I wanted how data flows in each component ... functionality. If the critical functions work like Vyapar and Privyr", then "see it as a whole picture how each section is connected. Make it like a story"). One month of a small business was carried out on an empty copy of the system, step by step through the API the screens use, and after every step every section was read back: 20 boards bought at 2,000, 2 rejected at the quality check and sent back, the supplier billed and paid; an enquiry from the website form becoming a lead, a WhatsApp reply, a price list opened, the lead won and turned into a customer; 15 boards ordered, delivered, invoiced and part paid; the bank statement matched; a transfer to the showroom, a quick bill to a walk-in, a return; rent; a month of attendance turned into a salary and paid; month end. All figures were worked out by hand first and the system gave the same figure every time: stock by place and its value, what suppliers are owed, what customers owe, the bank, GST charged and claimable, profit, and a balance sheet of 2,11,950 on both sides. It is kept as `apps/api/test/story.test.ts` (21 tests), so it is repeated on every change. The page for people who do not read code: https://claude.ai/artifact/4WLN4SZaN1YPM6qtihADYa (the story, how the sections connect, and the comparison with Vyapar and Privyr). **What the comparison found.** Against Vyapar: 11 critical functions work the same, 2 work differently, 2 groups are not built. The two differences: a credit sale is three steps here (order, delivery, invoice) where Vyapar has one "Add Sale" screen, and between delivery and invoice the cost is in the books without the sale; a purchase is four steps here (order, count in, quality check, bill) where Vyapar adds stock from one bill screen. Both follow the PRD. The counter sale (Quick bill) is one screen, as in Vyapar. Not built: proforma invoice, discount on the whole bill, cheques, loan accounts, cash flow report, barcode labels, bulk import of items and parties, e-way bill and e-invoice. Against Privyr: 8 the same, 2 built but never connected to the real services (leads from Meta, Google and WhatsApp; the automatic first WhatsApp), 1 not built (opportunity size and groups), and 1 that goes further (the lead carries on into the order and the payment). **Basis and limits:** run on a clean test copy of the same program, not on the live site or real data; what Vyapar and Privyr do is from their public pages and the Vyapar screens in the founder's call, neither app was operated. **Open question for Sarthak:** whether a one-screen credit sale and a one-screen purchase should be added beside the step-by-step ones. |
| 2026-10-13 | **System map, clean-up and comments for handover** (Sarthak: "Prepare me the flow chart of all the components made so far and how they are interconnected. Also start optimizing and cleaning the code, make it well commented so that each section has context, so that when passed on to some other developer it is easy to read and modify"). **Map:** `docs/ARCHITECTURE.md` (new) has the three programs, the path of one request, the whole system, the rules that hold everywhere, a table of every module with what it keeps, calls and posts, what each document writes to stock and to the books, the journeys, the database, the web app, how to add a feature, and the known debts. The same picture as a page for people who do not read code: https://claude.ai/artifact/9H1iMyj8UGhQaRnpXHfHEu. **Clean-up, with no change in behaviour:** the one import cycle (`sales.ts` and `collect.ts` imported each other) removed by keeping the invoice link with the invoice; dead code removed (`splitTax`, `ATTENDANCE_DAY_VALUE`, ten unused variables and imports); helpers that had been written out several times given one home each (the address formatter was in 7 screens, the month name in 4 files, the month check in 2, the state code of a GSTIN in 2). `noUnusedLocals` and `noUnusedParameters` are now on in `tsconfig.base.json`, so unused code fails `npm run typecheck` from here on. **Speed:** 20 indexes on the links that every document page and report searches by (lines by their document, allocations by their payment, entries by the entry they reverse), migration `0022_document_indexes`. Found by listing the foreign keys that had no index (96) and keeping those the code filters on. Database reads inside loops were looked for: the only ones are row locks taken while saving a single document, which have to be one at a time. **Comments:** every backend file now opens with what it is for and how it fits in (15 modules, the engines in `core/`, `app.ts`, `config.ts`, `server.ts`, `lib/errors.ts`, `lib/http.ts` and `db/seed.ts` had none); the long files are divided into named sections; 32 service functions that had no description have one; the shared package, `lib/api.ts`, `lib/session.tsx`, the UI kit and the menu say what they are. `app.ts` is regrouped by department with the stages a request passes numbered. **Not done yet** (ARCHITECTURE.md section 12): the screens treat API responses as untyped (about 300 `any`), the six largest modules are sectioned but not split into smaller files, list queries still sit inside route handlers, and there is no linter. Tests unchanged in number and all passing: 31 shared, 300 API, 8 simultaneous. |
| 2026-10-13 | **Job work out** (Vyapar's "Job Work Out (Challan)"; Sarthak, on being told it was the one Sale-menu item that is a feature of its own: "We can build this"). Material sent to an outside worker goes on a numbered challan (`JW/26-27/00001`). It stays ours: it moves, at the value it stands at, to a new place in stock, "With job workers" (location type `job_work`), so it is still in Stock in Hand but is no longer counted as available, and nothing but a challan can move it (a transfer, a count or a sale from there is refused). Each time something comes back a receipt (`JWR/..`) says, for every item sent, how much **came back as it went**, how much was **used to make something else**, and how much is **lost**. What was made comes into stock worth exactly what was used to make it, so a frame spoiled in the work is carried by the good ones and no paise are left over; a loss is written off to Stock Adjustment. The challan closes by itself when every unit is accounted for. The **job worker's charge** can be added to the cost of what came back: Dr Stock, Cr Job Work Charges to be Billed (new account 2310). When the job worker's bill is booked against the challan it settles that amount first and expenses only the rest, so the charge is never counted twice; a bill for less leaves the difference showing on the challan. Without a charge on the receipt, the bill is an ordinary expense. A receipt can be undone while the goods are still where it put them, and a challan cancelled while nothing has come back. The challan prints as a delivery challan for job work (both parties with GSTIN, HSN, quantity, value, what it is sent for, no tax). Two lists by date, sent out and came back, are the data for the GST job work return (ITC-04), and each challan shows the date a year on by which the material must be back. Stores → Job work (list, new challan, challan page, print); the challan page also takes the job worker's bill, which until now could not be entered on a screen at all for a service with no purchase order. Stock screen shows a "With job workers" column. Permissions `jobwork:read` and `jobwork:write` (stores, operations, admin). Migration `0021_job_work`, module `jobwork.ts`, 13 new API tests with hand-worked figures (`jobwork.test.ts`); checked through the screens on sample data. **Not done:** the portal's ITC-04 file, an e-way bill for the movement, capital goods (machines, moulds) sent out, sending straight from one job worker to another or to the customer, and a bill of materials (what was used is typed in each time). |
| 2026-10-13 | **Leads from WhatsApp and Meta** (Sarthak: "Get leads from whatsapp and meta"). The receiving side was already built on 9 Oct (signed webhooks for Meta lead ads and WhatsApp messages, a WhatsApp message from a new number starts a lead, a Click-to-WhatsApp ad's name is kept). What was missing was everything short of having the accounts; two things were added that do not need the webhook to be live. **Check the connections** (`POST /api/crm/integrations/check`): asks Meta which Page the page access token belongs to, whether that Page sends its lead forms to the app (`subscribed_apps`), and which number WhatsApp sending is connected to, and passes on Meta's own words when a token is wrong or expired; the screen also shows when Meta last accepted each callback address (`crm_state`). **Leads already in Meta's lead forms** (`POST /api/crm/integrations/meta/fetch`, 7, 30 or 90 days): reads every lead form of the Page, follows the pages of results, and takes in what is not here yet through the same path as a webhook lead (same phone check, owner, follow-up). It shares the webhook's key, so a lead is never added twice whichever way it arrives; an older lead says on its notes when it was filled in; at most 300 are taken per press. This also serves as the catch-up after an outage. 8 new API tests (`metapull.test.ts`) against the Graph API's documented answers; screen checked in its not-connected state. **Still needs the accounts, which only the owner of the Meta business can create:** a Meta developer app (app secret, a verify token, a long-lived Page token with `leads_retrieval`, `pages_read_engagement`, `pages_manage_ads`), the webhook subscribed for the Page's `leadgen` and the WhatsApp account's `messages`, and the business number on WhatsApp's Cloud API. Until then nothing has been tried against Meta itself. Note for that day: a number moved to the Cloud API stops working in the WhatsApp Business phone app unless it is connected in Meta's "coexistence" mode through a WhatsApp solution provider; decide that before moving the number the team uses today. |
| 2026-10-13 | **Bank statements by email** (founder: every bank transaction is typed into Vyapar by hand; the bank emails a password-protected statement; forward those mails to a mailbox made for the app, give the app that mailbox and the password, and let the entries arrive by themselves without doubling what is already entered; Sarthak: "Ok this also"). What already existed was the second half: a statement's lines are matched to the books and the rest wait for a reason. Added the first half. **Reading the PDF** (`lib/bank-pdf.ts`, library `unpdf`): opens a locked PDF with its password, rebuilds the table from where the text sits on the page (heading on one or two lines, figures against the right edge of their columns, narrations that run on, the heading repeated on every page), then uses the same reader as a CSV statement. Before anything is kept, every printed balance must follow from the one before; if the figures do not add up as read, nothing is imported and the message says so. **By hand**: the Bank reconciliation screen takes the PDF as well as a CSV; a locked one asks for its password, which can be remembered for the account (`POST /api/bank/statements/import-pdf`). **By itself**: a mailbox read over IMAP (`lib/mailbox.ts`, libraries `imapflow` and `mailparser`; read-only), a rule per bank account for recognising its mails (words in the sender's address and the subject) and its statement password (`bank_feeds`), and a record of every mail with what became of it (`bank_mails`): imported, left alone because it fits no rule, or could not be imported, with the reason, the file kept, and a **Try again** once the password or rule is put right. Two accounts that get the same kind of mail are told apart by whose password opens the PDF. The mailbox is read when the screen is opened (at most every half hour), on **Check the mailbox now**, and when a scheduler calls `/api/hooks/bank-mail/check` with `BANK_MAIL_CRON_SECRET`. The statement password is stored locked with a key from `APP_SECRET` (`lib/secret-box.ts`, AES-256-GCM) and is never sent to a screen or written to the audit trail. A second guard against doubles: a line with the same date, amount and balance as one already here is skipped even if its narration is worded differently, so a weekly statement and the monthly one, or a CSV and the PDF, never add a transaction twice. Migration `0020_bank_mail`; module `bank-mail.ts`; 25 new API tests (`bank-pdf.test.ts`, `bank-mail.test.ts`) using real locked PDFs made in several layouts and a stand-in mailbox. Checked in the browser (choose a locked PDF, wrong password, right password, remember it) and on a Vercel-shaped build against real PostgreSQL, including that the new libraries are among the files the host ships. README section "Bank statements by email". **Not proven yet, and said on the screen and in the README:** the reader has not been tried on a real statement from the bank (only on made-up ones), and the mailbox connection has not been tried against a real mail service. Both wait for the mailbox the founder said he would create. A direct link to the bank (no email) is not built. |
| 2026-10-13 | **Reports and TDS** (founder: Vyapar's reports are "very detailed": day book, party-wise profit, GSTR-1, sales by HSN, and "TDS is another compliance that we have to do"; Sarthak: "This also"). Books & reports has four new tabs. **Day book**: every transaction of a day or a range, one line each, with the cash and bank money it brought in or took out, totals, a breakdown by kind, a filter by kind, and a link to the document (`/api/accounting/reports/day-book`). **Profit by customer**: sale, cost, profit and margin per party, returns taken off; its totals always equal Profit by bill (`/reports/party-profit`). **Sales by HSN**: the GSTR-1 HSN table for any dates, with totals. **TDS**, built both ways round because a TDS report needs TDS to be recorded first. *Held back by us*: on a supplier payment (`payments.tds_amount`, the bill is settled for the money paid plus the TDS: Dr Creditors, Cr Bank, Cr TDS Payable (Vendors) 2450) and on an expense such as rent or professional fees (`expenses.tds_amount`, vendor name and PAN). *Held back by a customer*: on a receipt (Dr Bank, Dr TDS Receivable 1510, Cr Debtors), so the invoice shows fully paid although less money arrived. The TDS tab lists each deduction with the PAN, totals by kind of payment and by month with the due date (7th of the next month, 30 April for March), what is owed now, deposits to the government (never more than is owed, cancellable, for vendors or for payroll's salary TDS), and what customers held back. Kinds of payment and rates are a list accounts can edit (`tds_rates`): eight usual ones are seeded with the rate in general use and the place in the law (section 393 of the Income-tax Act, 2025, in force from 1 April 2026, with the earlier section named); the return's code is a blank field to fill in. PAN added to parties (read from the GSTIN when there is one). Migration `0019_tds`, module `tds.ts`, `packages/shared/src/tds.ts`, 12 new API tests with hand-worked figures (`reports.test.ts`) and 3 shared. Checked in the browser on sample bills, including the payment form working the TDS out and the printed receipt showing it. **Not done:** TDS thresholds are not checked (the person paying decides whether TDS applies), TDS at the time a purchase bill is booked rather than paid, the quarterly return file itself, and certificates. The seeded rates come from general knowledge and secondary sources, so accounts should look them over once. |
| 2026-10-13 | **Masters** (founder call of 13 Oct, then Sarthak: "Start building this, I think he wanted items master and employees master and customers master"). The founder's rule: master data is the one source every module reads, it is changed in one place, and only an admin can change it. The records were already single (every module reads the same item, party and employee rows); what changed is who may edit them and where. `items:write` is now admin only (was admin, accounts, stores); new `parties:manage` (change a party, its price list, credit limit, terms) and `employees:manage` (add and change an employee, salary, deductions, bank, sign-in), both admin only. `parties:write` now means adding a new customer or supplier while working, and refuses commercial terms. Hire and exit stay with HR. New screen Admin → Masters (`/masters`, shared list components in `components/masters.tsx` used by the Items, Parties and Employees screens too), `GET /api/masters/summary`, and `GET /api/masters/export`: one workbook, sheets Items, Customers, Suppliers, Employees (the last only for someone who may change employees, because it carries salaries and bank accounts); each download is in the audit trail. `lib/xlsx.ts` now writes workbooks with several sheets and spells SKU, HSN, GST, GSTIN, MRP in capitals in headings. 10 new API tests (`masters.test.ts`). Checked in the browser as admin and as sales, and the workbook opened with a spreadsheet library. Not done: bulk entry and import of items or parties from a file, which the founder also mentioned. |
| 2026-10-13 | Founder call (recorded by Sarthak, 36 min; first 4 min have no sound). What he said: the screens look good but he has not seen how the modules link and wants to check the logic between them; priority is operations, sales, marketing and CRM, with attendance and payroll last; asks were a Masters area, bank transactions read from the emailed statement, barcode generator and bulk import, Vyapar-level reports (day book, party-wise profit, HSN summary, TDS), IndiaMART leads; he asked Sarthak to share the PRD and take three or four ERP demos (Zoho a must). Sarthak picked four to build first: Masters, bank statement by email, the reports, leads from WhatsApp and Meta. |
| 2026-10-12 | Why two Vercel deployments failed (commits `4688a24` and `20dc032`): Vercel's emails, which Sarthak forwarded, say "Git provider error: GitHub fetch error, status 403, you have exceeded a secondary rate limit". GitHub briefly refused to let Vercel download the commit, so the build never started (both failed about ten seconds after the push). Nothing in the code was at fault and the next push deployed each time. My first explanation, a sleeping database, was wrong. If it happens again: wait a few minutes and press Redeploy in Vercel, or let the next push carry it. What made GitHub rate-limit at those two moments is not known. |
| 2026-10-12 | **Payroll** (Sarthak confirmed "Attendo" is Petpooja's attendance and payroll app, so payroll was its main missing feature; the PRD had left payroll out). `packages/shared/src/payroll.ts` (`computePay`), `modules/payroll.ts`, migration `0018`, new accounts 1500 and 2400 to 2440, permissions `payroll:read` / `payroll:manage`. A month's salary is worked out from the register (days worked, paid leave, weekly offs and holidays are paid; absent and unmarked working days are not), with PF and ESIC by the usual rates where switched on for the person, professional tax and TDS as amounts per person, advances taken back a set amount a month, and a bonus or fine per person. Draft → approved (one balanced entry in the books, refuses unmarked days unless told to) → paid; an approved month can be reopened. Payslips on screen, on the person's "My work" and as a link; bank list in Excel. 5 calculation tests and 11 API tests with hand-checked figures. Monthly salaries only; PF and ESIC rates are the general ones and editable under Payroll → Rules. |
| 2026-10-12 | Reference apps, CRM part (Privyr): **follow-up plans** (`follow_up_plans`, `modules/plans.ts`; steps over days, a lead is due on the day of its next step, contacting it on or after that day moves it on, the plan stops on a reply, a sale or a loss; one plan can be the usual one for every new lead), **leads from a spreadsheet** (`/api/leads/import`), **many leads at once** (tick on the list: hand over, or message one tap each), **team table** per person on the marketing dashboard. Migration `0017`, 7 tests. Steps are done by a person pressing send; sending by itself waits for the WhatsApp number. |
| 2026-10-12 | Reference apps, accounts part (Vyapar): **payment reminders** (Accounts → To collect; `/api/payments/reminders`, message with amounts and a link to each bill, each sending noted), **the bill as a link** the customer opens without signing in (`invoice_links`, public page `/i/<token>`; kept beside the invoice because an issued invoice cannot be changed; shows no costs or notes), **cash and bank transfers** (`/api/accounting/transfers`, reversible), **profit by bill** (Books & reports). Migration `0016`, 7 tests. Known gap this exposes: an online order already paid on Shopify becomes an unpaid invoice here until the gateway payout is recorded against it, so it shows under To collect. |
| 2026-10-12 | Reference apps (founder: Vyapar for accounts, Privyr for CRM, Attendo for HR; he suggested the REA decompiling tool). Gap list in `docs/REFERENCE-APPS.md`, made from the vendors' public feature pages; REA was not run on them (their features are published, and decompiling a commercial app breaks its terms). First part built, HR: **clock in and out from the phone** with location and distance from the workplace (`/api/hr/me/*`, "My attendance" on My work), **leave requests** approved by HR that write themselves into the register (`leave_requests`), **attendance rules** (start time and grace for late marks, weekly off, workplace), late days and hours in the monthly summary. Migration `0015`, 12 tests. Which "Attendo" the founder means is not confirmed. |
| 2026-10-12 | WhatsApp messages sent from inside the app, ready to connect: `POST /api/crm/leads/:id/whatsapp` sends free text or a quick reply through the WhatsApp Cloud API (`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`), logs it only once WhatsApp accepts it, and explains the 24-hour rule in plain words when WhatsApp refuses. The lead's page shows the messages both ways as a chat. 5 tests against the documented request and error replies. **Not connected: the send box has only been exercised through the API tests, never against WhatsApp itself.** |
| 2026-10-12 | Menu sections are dropdowns (Sarthak): one open at a time, opening another closes the current one, and the section of the screen you are on opens by itself. |
| 2026-10-12 | Files sent to a lead, with tracking (Sarthak: connections are hooked up later, during testing; keep building). A file gets a link of its own per lead (`lead_shares`, migration `0014`, `modules/shares.ts`, public page `/s/<token>`); it counts as opened when that page is on a screen, not when a chat app fetches a preview; the first opening goes on the lead's timeline and raises a notice for the owner and the sender. Links can be switched off; a file sent before can be reused. 5 tests. |
| 2026-10-12 | Item pictures on the items screen: add from the camera or a file, remove, first picture shown as a thumbnail in the list (`GET` / `DELETE /api/items/:id/images`). |
| 2026-10-12 | Lead score and new-lead notices. Score: 0 to 100 from the stage, the items asked about, calls and messages in the last week, how new the lead is and whether the phone has bought before (rules in one place, `SCORE_JOIN` in `leads.ts`); shown as Hot / Warm / Cold with the number on the list, the board and the lead's page, which lists the points; "Hottest first" sorts the list. Notices: `/api/leads/alerts`, asked every 30 seconds while the app is open, shows a notice for a lead given to you (or any lead, for whoever manages lead sources) and a browser notification once allowed. 5 tests. Notices need the app open in a tab or installed; nothing is sent when it is closed. |
| 2026-10-12 | Online orders (Sarthak: "continue building the remaining features"). Shopify webhook (`/api/hooks/shopify`, signed with `SHOPIFY_WEBHOOK_SECRET`; new orders and cancellations) and Amazon / Flipkart order-report import, all ending in `takeOrder` (`modules/online.ts`): a confirmed sales order matched by SKU, the customer matched on phone then email (marketplace orders under one party each), place of supply from the shipping state, shipping as a `SHIPPING` service line, never taken in twice. Stuck orders stay on the new Sales → Online orders screen with the reason and a retry. Migration `0013_online_orders`, 14 tests, README section. **Not connected to a real Shopify store, and the Amazon / Flipkart column names have not been checked against a real export.** |
| 2026-10-12 | Install as an app (Sarthak: an install button like YouTube's). Manifest with 192 and 512 px icons, a service worker that keeps nothing on the device, and an "Install app" button in the menu and on the sign-in page (shown only when the browser offers installation; on an iPhone it explains Share → Add to Home Screen). Checked locally with a simulated install prompt; the real prompt needs Chrome or Edge on the live site. |
| 2026-10-12 | Vercel had blocked every deployment started by a push since 10 Oct ("Deployment was blocked"): the commits were recorded under the GitHub account `jainsarthak0205`, not `sarthakradboards-hash`, which owns the repository and the Vercel project. Commits in this repository are now recorded under the owning account (repository-only git setting). Also added an app icon and a home-screen manifest. |
| 2026-10-12 | Phone layout (Sarthak: "make this app phone friendly"). Under 860 px the menu is a panel that slides in from a top bar; under 640 px lists become cards (one per row, the column title beside each value, the whole card opens the record), controls are finger-sized with 16 px text, forms are one column, boards swipe a column at a time, and the bill line editor and attendance register stack too. Wide grids (permissions, resource allocation, journal) still scroll sideways. Checked at 375 px on every menu screen and six detail screens: nothing spills off the side; the wide-screen layout is unchanged. |
| 2026-10-12 | Decision (Sarthak): the real system will move to AWS later; the review copy stays on Vercel until then. The server package (`compose.prod.yml`) runs on an AWS server as it is (Lightsail Mumbai is the option already priced in section 6). |
| 2026-10-12 | Founder, after looking at the review copy (WhatsApp to Sarthak, 10:54): "The fundamentals looks good on the over view", "you can proceed with the ERP". A general go-ahead, not a screen-by-screen sign-off. |
| 2026-10-10 | Review copy is live at https://radcore-erp.vercel.app (Sarthak set it up in Vercel). Checked from outside: screens load, the API answers from Singapore in about 0.3 s with its database connected, a cross-site request is refused. Sign-in and the sample data are for Sarthak to confirm (the password is his). |
| 2026-10-10 | First-group screens checked in the browser on sample data: quotation and purchase order documents, credit used on another invoice, a card payout matched to three receipts with the bank's fee booked, the permissions screen (change and reset), the QR card, leave balances, and the upload control (a good file and a refused one). Fixes from that pass: bank lines now say Matched / Unmatched / Ignored and users and campaign links say Active / Switched off (they borrowed "Approved" / "Closed"); short forms such as HR, UPI and GST are capitalised everywhere; the sample data now has three campaign links so the QR code can be seen. |
| 2026-10-10 | File attachments: `files` table (migration `0011`), `/api/files` (PDF, JPG, PNG, WEBP up to 10 MB, checked by content, access by kind of file), upload control on the applicant and expense forms, a volume and a backup copy on the server. This completes the first group of remaining work. |
| 2026-10-10 | Print documents for quotations / sales orders and purchase orders; permission matrix editable on screen (`permission_overrides` setting, `PUT /api/settings/permissions/:key`). |
| 2026-10-10 | Review copy for "go live for review" (Sarthak, 10 Oct): `SEED_DEMO_DATA=true` + `DEMO_PASSWORD` loads the sample data once into an empty database on a real server, with a sign-in per role and a banner saying it is sample data. The sample data seed is now covered by a test. Waiting on Sarthak for where to host it. |
| 2026-10-10 | Bank reconciliation: one statement line to several book entries, with the bank's fee booked in the same step (`bank_line_matches`, migration `0009`, which carries existing matches over; upgrade checked on PostgreSQL 18). |
| 2026-10-10 | Excel export on every list and report (`lib/xlsx.ts`, no library); GSTR-1 file for the GST portal (`/api/gst/gstr1/portal-file`). |
| 2026-10-10 | Credit note credit against another invoice: `credit_applications` (migration `0008`, which also extends `v_invoice_outstanding`), `credits.ts`, invoice page, 6 tests. No journal entry is involved: it only changes which invoice is open. |
| 2026-10-10 | Stores dashboard and owner's summary (`/api/dashboards/stores`, `/owner`); ad spend with cost per lead (`ad_spends`, migration `0007_ad_spend`, CRM → Ad spend). |
| 2026-10-10 | Year-end close: `fiscal_closes` table (migration `0006_year_end_close`), `closeYear` / `reopenYear` in `accounting.ts`, Financial years tab, 5 tests. |
| 2026-10-09 | **CRM lead capture** (Sarthak: a connected CRM like Privyr, which the team uses today; basic structure first). Webhooks for Meta lead ads, Google Ads lead forms, WhatsApp and website forms, all ending in the same `captureLead`; event log with reasons and retry; quick replies with one-tap WhatsApp contact; Lead sources and Quick replies screens; CRM section in the menu. Migration `0005_crm_integrations`, module `crm.ts`, 17 new API tests, README section. Tested with the documented payloads and a live run in the demo; not yet connected to real Meta / Google / WhatsApp accounts. |
| 2026-10-09 | Founder's requests (via Sarthak): **task deadlines** (every task has a deadline date and an optional time; late is to the minute; routines can carry a finish-by time), **project management** under Operations (projects with an owner, deadline, tasks, progress and a plan against the calendar; the owner can run their own project without operations access), and a **Resource allocation** tab (people and machines committed to projects or other work by period and share of time, week-by-week board, over-allocation refused unless confirmed). Migration `0004_projects_and_allocation`, module `projects.ts`, 11 new API tests. Screens checked on demo data. |
| 2026-10-09 | Visuals (founder's request): charts on the sales, marketing and accounts dashboards (`apps/web/components/charts.tsx`, no chart library), the home screen as a flow of what is waiting at each step (`GET /api/dashboards/overview`), and progress steps on leads, sales orders, purchase orders and goods receipts. Chart colours checked for colour-blind separation; every chart has a table behind it. |
