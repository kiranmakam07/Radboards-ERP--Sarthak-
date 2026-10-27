# RadCore: code review, 27 October 2026

A review of the code module by module (Sarthak, 27 Oct 2026: "go thru the code module by module, check for errors
and problems, also keep a track of those errors with respect to the document, and also optimize and clean the
code"). Each finding is tied to the risk it belongs to in the founder's technical review (the 26 Oct proposal) and
to the test step in the testing document (`exports/RadCore - Review for testing`, section 3).

Every fix has an automated test that fails without it (`apps/api/test/code-review.test.ts` unless named).
After the fixes: 532 tests pass (31 shared, 501 API), on the in-memory database and on PostgreSQL 16; the web app
builds.

## What was read

- **Read in full:** every engine in `core/` (journal, stock, units, auth, numbering, settings, audit, access,
  stages, tax rates) and every tool in `lib/`; the modules sales, purchasing, payments, credits, accounting
  (expenses, journals, transfers, year close, ageing), inventory (transfers, adjustments), service, imports,
  pipeline, the GST summary, files, admin (sign-in, users, settings), the public invoice link, the home overview.
- **Checked across the whole code base:** every route open to any signed-in user (40, each checked for its own
  ownership check); every document read on a write path without a row lock (37); the signatures on the webhooks
  (Meta, WhatsApp, Shopify, the scheduler hooks); every save button on the screens that calls the API itself
  (37 files); the published advisories of the libraries the app uses.
- **Not read line by line this time:** hr, ops, projects, leads, crm (beyond its webhooks), lead-tools, plans,
  shares, jobwork, reservations, units, items, parties, tds. Payroll, hr-self, opening and health were read in
  full on 26 Oct when they were changed. Their tests and the screen sweep (311 screens, every role) cover them.

## Findings

Level: **Serious** wrong money, stock or tax in normal use · **Moderate** wrong in a case that will come up ·
**Minor** rare, or tidiness.

| # | Where | What was wrong | Level | Review risk | Test step | Status |
|---|---|---|---|---|---|---|
| CR-01 | `core/stock.ts` | Stock held at no value (a sample, free goods) went out at the item's purchase price, so the stock's value went below zero | Moderate | Stock and cash leaks | — | Fixed |
| CR-02 | `lib/errors.ts` | A server fault raised on purpose (an entry that does not balance, a 500) was answered but not sent to the alert channel; only unexpected errors were | Moderate | No alarms | F16 | Fixed |
| CR-03 | `modules/sales.ts` | Cancelling a sale with the goods put back always put them in the Showroom, even when they were delivered from Stores | Moderate | Stock and cash leaks | — | Fixed (`p1-foundations.test.ts`) |
| CR-04 | `modules/purchasing.ts` | Editing a draft PO to a supplier outside India put GST back on its lines (the 26 Oct import rule was missed on that path) | Moderate | GST returns | F2 | Fixed |
| CR-05 | `modules/accounting.ts` | An expense with GST could be added to, or cancelled in, a month whose GSTR-3B is filed (the 26 Oct lock covered bills, not expenses) | Moderate | GST returns | F1 | Fixed |
| CR-06 | `modules/gst.ts`, `modules/imports.ts` | GSTR-3B left out the IGST paid at customs on imports: the books had the credit, the return summary did not, so it would be under-claimed. Its month was not locked when filed either | Serious | GST returns | B2 | Fixed |
| CR-07 | `modules/accounting.ts` | Moving from Vyapar says "reverse the entry to bring the balances in again", but the reverse route refused entries that are not manual | Moderate | Moving off Vyapar | G2 | Fixed |
| CR-08 | `modules/accounting.ts`, Books & reports | The receivables and payables ageing listed bills only: a balance brought in from Vyapar (no bill behind it) did not show at all. Now a "Not on a bill" column, and the total is the party's account | Moderate | Moving off Vyapar | G2 | Fixed |
| CR-09 | `modules/accounting.ts`, schema | A manual journal entry could be reversed twice by two people at once (no lock, nothing in the database to stop it). Now locked, and a unique index | Moderate | Stock and cash leaks | — | Fixed (migration 0042) |
| CR-10 | `modules/admin.ts` | The full staff list, with every phone number and email, was open to anyone signed in. Only the Users screen uses it; the others use the names-only list | Moderate | Who can do what; private data | F10 | Fixed |
| CR-11 | Screens | A quick second click saved twice on: issuing a credit note, cancelling an invoice, posting a manual journal, delivering an order, holding stock, fitting a part, QC and inward, stock transfers / counts / adjustments / opening stock, a new quote, a new PO. One shared guard (`useSaving`) now: one save at a time, with its save key | Serious | Stock and cash leaks | F4 | Fixed |
| CR-12 | `modules/pipeline.ts`, `sales.ts`, `payments.ts` | A vehicle's booking advance stayed unallocated: once delivered and billed, the bill showed as fully owed and could be chased. The advance now names its order and pays the bill when it is made | Moderate | Stock and cash leaks | C2 | Fixed (`pipeline.test.ts`) |
| CR-13 | `modules/service.ts` | Two people taking the same unit in at once could open two job cards on it | Minor | Stock and cash leaks | A1 | Fixed (row lock) |
| CR-14 | `lib/secret-box.ts` | The key that locks statement passwords was re-made (a deliberately slow step) on every use, blocking the server each time | Minor | — | — | Fixed (made once) |
| CR-15 | several | Clean-up: duplicated and stray comments (settings, access, http), a comment naming a route that does not exist, comments stacked above the wrong route (sales, purchasing), duplicate-line checks left over beside `assertOnce` (credit notes, goods receipts) | Minor | — | — | Done |
| CR-16 | dependencies | Published advisories in the libraries the app runs: body-parser 2.0-2.3 (high: a crafted compressed request can tie the server up), nodemailer through mailparser (moderate: address parsing), zod 3 (high: memory on oversized lists; the fix is zod 4, a larger change). Request bodies are capped at 1 MB and lists at fixed sizes, which limits the last | Serious | Updates and outside software | — | **Open:** updating downloads new versions, waiting for Sarthak's OK |
| CR-17 | `modules/service.ts` | Handing a vehicle back runs the normal credit check: a customer with an overdue bill cannot get it back, and the hand-back screen has no override | Moderate | — | A4 | **Open:** a decision (with "payment at hand-back", testing doc section 6) |
| CR-18 | `modules/service.ts` | A supplier's credit for a warranty claim is booked without its GST: input tax is not reversed when the supplier's note carries GST | Minor | GST returns | A5 | **Open** |
| CR-19 | `modules/sales.ts` | A credit note is not stopped after the GST time limit for one (30 November after the financial year) | Minor | GST returns | — | **Open** |
| CR-20 | Books & reports | The day book shows up to 5,000 entries for a range without saying when it stops there | Minor | Screens | — | **Open** |
| CR-21 | To collect | Payment reminders list bills only: a balance brought in from Vyapar is on the ageing now (CR-08) but not in the reminders | Minor | Moving off Vyapar | — | **Open** |

## Migrations

`0042_review_fixes_2`: `payments.sales_order_id` (a booking advance names its order; advances taken before are
linked by their note), and a unique index on `journal_entries.reverses_entry_id` in place of the plain one.
