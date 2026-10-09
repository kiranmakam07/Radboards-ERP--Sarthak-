# RadCore — Radboards ERP

One connected system for leads, sales, inventory, purchasing, accounts and GST, built from
`PRD: Radboards ERP` (v1 draft, 7 Oct 2026). A lead captured once flows into a party, an
order, a GST invoice, a stock movement and a ledger entry — nothing is retyped.

**What is built, what is not, and every decision taken: [`docs/PROGRESS.md`](docs/PROGRESS.md).**
Keep that file up to date with every change.

## Layout

```
apps/api         Express + TypeScript REST API (the backend — where the rules live)
apps/web         Next.js web app (deliberately simple; every rule is enforced by the API)
packages/shared  Money, GST, phone, financial-year helpers, state machines, permission matrix
docs/            PROGRESS.md (tracker + decisions)
```

## Try it in two minutes (demo data, nothing saved)

Needs Node.js 22+.

```bash
npm install
```

```bash
npm run demo
```

Open http://localhost:3000. The demo runs on a throwaway in-memory database with sample
items, stock, parties and leads. Sign in with phone `9000000006` (admin); the other roles
are `9000000000`–`9000000005` (owner, marketing, store, sales, stores, accounts). The demo
password is in `apps/api/src/db/demo.ts` (`DEMO_PASSWORD`). Everything resets when you stop it.

## Run it for real

```bash
cp .env.example .env
```

```bash
npm run dev
```

- With no `DATABASE_URL`, the API uses an embedded PostgreSQL (PGlite) stored in
  `apps/api/.data/` — zero setup, fine for a single machine and for trying things out.
- For staging/production set `DATABASE_URL=postgres://…` to a real PostgreSQL 16+. The same
  migrations and code run on both. (`docker compose up -d` starts a local Postgres on port 5433.)
- On first start, when there are no users, the API creates an admin and prints the password
  **once** in the terminal. Set `SEED_ADMIN_PHONE` / `SEED_ADMIN_PASSWORD` in `.env`
  beforehand to choose your own. Change it after signing in.
- First things to do as admin: **Setup → Company profile** (GSTIN and state drive the
  CGST/SGST vs IGST split), add users, add items, then enter opening stock
  (**Stock → Opening stock**, approved by admin/owner).

## Run it on a server

`compose.prod.yml` runs everything on one Linux server: PostgreSQL 16, the API, the web app,
Caddy for automatic HTTPS, and a daily database backup. It needs Docker, and a domain name
whose DNS points at the server.

```bash
cp .env.production.example .env.production
```

Fill in `DOMAIN`, `POSTGRES_PASSWORD` and the first admin's phone and password, then:

```bash
docker compose --env-file .env.production -f compose.prod.yml up -d --build
```

- **First sign-in:** the admin from `.env.production`. Change the password, then fill in
  Setup → Company profile and add the users.
- **Updating:** `git pull`, then the same `up -d --build` command. Database migrations are
  applied automatically when the API starts.
- **Backups:** one compressed dump per day in `./backups` on the server, kept for
  `BACKUP_KEEP_DAYS` (30). They are on the same disk as the database, so also copy that
  folder off the server (provider snapshots or object storage).
- **Attached files** (resumes, bill photos) are kept on their own volume, not in the database, and are
  copied into `./backups` as `uploads_<date>.tar.gz` alongside the database dump.
- **Restore:** `docker compose --env-file .env.production -f compose.prod.yml exec -T db pg_restore --clean --if-exists -U radcore -d radcore < backups/<file>.dump`
- **Logs:** `docker compose --env-file .env.production -f compose.prod.yml logs -f api`

CI builds these images and starts the stack on every push, so a broken build is caught
before it reaches the server.

### A review copy

To let people try the system before it holds real data, set `SEED_DEMO_DATA=true` and your own
`DEMO_PASSWORD` in `.env.production` before the first start. The empty database is then filled
with sample customers, stock, leads, staff, tasks and a project, and one sign-in per role:

| Role | Phone | Role | Phone |
| --- | --- | --- | --- |
| Owner | 9000000000 | Accounts | 9000000005 |
| Marketing | 9000000001 | Admin | 9000000006 |
| Store | 9000000002 | HR | 9000000007 |
| Sales | 9000000003 | Operations | 9000000008 |
| Stores | 9000000004 | | |

All use `DEMO_PASSWORD`. A banner on every screen says it is sample data. Everything works as in
the real system and is saved, so reviewers can enter things and see them the next day.

Sample data is only ever loaded into an empty database. **To go from the review copy to the real
system**, stop the stack, remove the database (this deletes everything entered during the review),
set `SEED_DEMO_DATA=false`, and start again; the first admin from `.env.production` is then created:

```bash
docker compose --env-file .env.production -f compose.prod.yml down -v
```

## Connecting lead sources

Every outside source ends in the same lead list (same phone check, owner and first follow-up as
a lead typed in by hand). The screen **CRM → Lead sources** shows each address to copy, whether
it is connected, and everything that has come in.

| Source | Address | What proves the request |
| --- | --- | --- |
| Meta lead ads (Facebook, Instagram) | `https://<domain>/api/hooks/meta` | Meta's signature, checked with `META_APP_SECRET` |
| WhatsApp Business (Cloud API) | `https://<domain>/api/hooks/whatsapp` | the same signature |
| Google Ads lead forms | `https://<domain>/api/hooks/google-ads` | the form's key = the key of a campaign link |
| Website or any form tool | `https://<domain>/api/hooks/form/<campaign key>` | the campaign key in the address |

- **Meta lead ads:** in the Meta app, add the Webhooks product, subscribe the *Page* object's
  `leadgen` field with the address above and `META_VERIFY_TOKEN`, then subscribe the Facebook Page
  to the app. `META_PAGE_ACCESS_TOKEN` must be a long-lived Page token with `leads_retrieval`.
- **WhatsApp:** the business number has to be on the WhatsApp Cloud API. Subscribe the
  *WhatsApp Business Account* object's `messages` field with the address above. Messages are
  received; replies are sent from a lead's page, which opens WhatsApp with the message written.
- **Google Ads:** make a campaign link with the source *Google Ads*, then in the lead form asset
  choose *Webhook*, and enter the address and that link's key. Google's "send test data" shows up
  on the Lead sources screen as a test and creates no lead.
- Anything that could not become a lead (no phone number, a number outside India, Meta refusing
  to hand the lead over) stays on that screen with the reason and a retry button.

## Commands

| Command | What it does |
| --- | --- |
| `npm run demo` | API on in-memory demo data + web app |
| `npm run dev` | API + web app against your database |
| `npm test` | All automated tests (shared + API) |
| `TEST_DATABASE_URL=postgres://… npm test -w @radcore/api` | The API tests on a real PostgreSQL server, including the simultaneous-request tests |
| `npm run typecheck` | TypeScript check for all three packages |
| `npm run build:web` | Production build of the web app |
| `npm run db:generate` | Generate a SQL migration after editing `apps/api/src/db/schema.ts` |
| `npm run db:migrate` | Apply pending migrations |

## How the backend keeps the books right

- **One stock ledger.** Every change is an append-only `stock_movements` row; stock on hand
  is always `sum(qty)`, never a stored number. Valuation is moving average.
- **One posting service.** Every financial document posts balanced double-entry journal
  lines in the same database transaction as the document. Journals are append-only;
  cancelling a document writes mirror entries.
- **The database backs the code up.** Triggers reject any update/delete on the stock ledger,
  journal and audit log, any unbalanced journal entry (checked at commit), any posting in a
  locked period, and any change to an issued invoice.
- **Gap-free numbering.** Document numbers are taken under a row lock inside the
  transaction, so a failed bill never burns a number.
- **Running figures are derived.** Party balances, outstanding amounts, payment status,
  conversion rates and all reports are queries, so they cannot drift.
- **Audit trail.** Every create, update, cancel and status change is logged with the user
  and before/after values.

The API speaks snake_case JSON under `/api`. Every list and report takes `?format=csv`.
Tests in `apps/api/test` run the whole business story end to end with hand-checked figures.
