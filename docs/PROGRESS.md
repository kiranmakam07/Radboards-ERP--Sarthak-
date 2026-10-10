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
| Frontend | Simple working screens for every built flow (58 screens, plain styling), with charts on the dashboards, a "what is waiting where" picture on the home screen and progress steps on documents |
| Automated tests | 196 passing: 23 shared, 165 API integration (hand-checked figures), 8 simultaneous-request tests. The API tests pass on both the in-memory database and real PostgreSQL |
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
| 7.6 | Item master, locations, append-only stock ledger | ✅ | Item pictures can be stored (file storage exists and the API takes an attached file or a link); there is no picture control on the items screen yet |
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
| 7.13 | Permission matrix | ✅ | Enforced on every route. Admin → Permissions shows who can do what and lets an admin tick or untick any role for any permission; changes take effect at once and are in the audit trail. The admin role always holds everything |
| 7.13 | Numbering series, integration settings | 🟡 | Series are visible, not editable. No integration settings yet |
| 7.14 | HR (Tier 2): openings, applicants → interview rounds → hired (creates the employee) or rejected, employees, attendance (daily register, CSV import, month summary), HR dashboard | ✅ | 20 API tests. Every screen checked in the browser on demo data. Resumes are attached as files (PDF or photo), open to HR and to whoever is taking the interview. The attendance import takes a plain CSV (employee number or phone, date, status, optional in/out times); the real export from the current attendance app has not been seen yet. Leave balances per leave year (entitled, taken, left). No payroll |
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
7. Shopify orders coming in automatically, then Amazon and Flipkart.
8. CRM, once real leads flow (Sarthak: basic structure first, optimise later): sending WhatsApp replies from
   inside the app, an alert the moment a lead arrives, lead scoring, files shared with view tracking.

For go-live, the CRM connections also need (not before then): a Meta developer app with the Page and
`leads_retrieval`, the WhatsApp Business number moved to the Cloud API, and the webhook set on each
Google Ads lead form. The steps are in the README under "Connecting lead sources".
8. HR and operations follow-ups, if wanted: a picture control on the items screen,
   WhatsApp reminders for tasks and maintenance.

HR and operations were built on 9 Oct 2026 (Sarthak: they are part of the app, not a later phase).

For go-live, when it is close (nothing needed before then):
- A server and a domain. Deployment is then the two commands in the README.
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
