import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { idempotent } from './lib/idempotency';
import { config } from './config';
import { authenticate, requireAuth } from './core/auth';
import type { DB } from './db/client';
import { AppError, errorHandler, forbidden, setProblemReporter } from './lib/errors';
import { recordProblem } from './core/alerts';
import { healthRouter, jobsHookRouter } from './modules/health';
import { openingRouter } from './modules/opening';
import { hideCosts } from './lib/http';
import { readMailbox } from './lib/mailbox';
import { accountingRouter } from './modules/accounting';
import { authRouter, mastersRouter, settingsRouter, usersRouter } from './modules/admin';
import { bankRouter } from './modules/bank';
import { bankMailHookRouter, bankMailRouter, type MailDeps } from './modules/bank-mail';
import { collectRouter, publicInvoiceRouter } from './modules/collect';
import { crmRouter, defaultDeps, hooksRouter, type CrmDeps } from './modules/crm';
import { dashboardsRouter } from './modules/dashboards';
import { filesRouter } from './modules/files';
import { gstRouter } from './modules/gst';
import { hrRouter } from './modules/hr';
import { hrSelfRouter } from './modules/hr-self';
import { inventoryRouter } from './modules/inventory';
import { itemsRouter } from './modules/items';
import { jobWorkRouter } from './modules/jobwork';
import { leadToolsRouter } from './modules/lead-tools';
import { leadsRouter, publicLeadsRouter } from './modules/leads';
import { onlineRouter } from './modules/online-router';
import { opsRouter } from './modules/ops';
import { partiesRouter } from './modules/parties';
import { paymentsRouter } from './modules/payments';
import { myPayslipRouter, payrollRouter, publicPayslipRouter } from './modules/payroll';
import { projectsRouter } from './modules/projects';
import { purchasingRouter } from './modules/purchasing';
import { reservationsRouter } from './modules/reservations';
import { salesRouter } from './modules/sales';
import { publicSharesRouter, sharesRouter } from './modules/shares';
import { tdsRouter } from './modules/tds';
import { unitsRouter } from './modules/units';
import { publicEstimateRouter, serviceRouter } from './modules/service';
import { importsRouter } from './modules/imports';
import { pipelineRouter } from './modules/pipeline';

/**
 * The API's front door. createApp builds the Express app: every router in the system is mounted
 * here, in the order a request meets them, so this file is the list of everything the API offers.
 *
 * A request passes, in order:
 *   1. public routes     no sign-in; limited per address (the enquiry form, links sent to people)
 *   2. webhooks          no sign-in; each proves itself with a signature or a key
 *   3. sameOriginOnly    refuses a change sent from another website
 *   4. authenticate      reads the session cookie into req.user
 *   5. requireAuth       everything after this needs a signed-in user
 *   6. the module routers, where each route names its own permission with requirePerm
 *   7. errorHandler      turns anything thrown into { error: { code, message } }
 *
 * Nothing here knows which database driver is in use or reaches the outside world itself: the
 * database comes in as `db`, and network calls (Meta, the statements mailbox) come in as `deps`,
 * so the tests can stand in for both.
 *
 * Where routers share an address (/api/leads, /api/bank, /api/hr, /api/ops, /api/payments,
 * /api/sales) their order matters: a fixed path such as /api/leads/shared-files has to be met
 * before /api/leads/:id would take it for an id. Keep the order when adding to those.
 */

/**
 * CSRF defence in depth on top of the SameSite=Lax session cookie: a browser always sends
 * Origin on cross-site POSTs, so a state-changing request from any origin other than our
 * own web app is refused. Non-browser clients (no Origin header) are unaffected.
 */
function sameOriginOnly(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  const allowed = config.webOrigin.split(',').map((s) => s.trim());
  const self = `${req.protocol}://${req.headers.host}`;
  if (allowed.includes(origin) || origin === self) return next();
  throw forbidden('Cross-site request blocked');
}

const toSnake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

// PostgreSQL prints timestamptz as "2026-10-08 03:32:08.575+00"; browsers need ISO-8601.
const PG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/;

/**
 * The API speaks snake_case everywhere (same names as the database columns in the PRD),
 * for requests and responses alike, and every timestamp goes out as ISO-8601 UTC. Rows
 * come back from the ORM in camelCase and from raw SQL in PostgreSQL's own formats; both
 * are normalised here, in one place.
 */
function snakeKeys(value: unknown): unknown {
  if (typeof value === 'string') {
    const m = value.length <= 35 ? PG_TIMESTAMP.exec(value) : null;
    return m ? new Date(`${m[1]}T${m[2]}${m[3]}:${m[4] ?? '00'}`).toISOString() : value;
  }
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[toSnake(k)] = snakeKeys(v);
    return out;
  }
  return value;
}

/** Everything the app reaches outside itself for, so that tests can stand in for the outside world. */
export type AppDeps = CrmDeps & MailDeps;

/** The statements mailbox, when one is set on the server. */
const mailboxReader: MailDeps['readMailbox'] = config.bankMailHost && config.bankMailUser && config.bankMailPassword
  ? (opts) => readMailbox({
      host: config.bankMailHost, port: config.bankMailPort, user: config.bankMailUser, password: config.bankMailPassword, folder: config.bankMailFolder,
    }, opts)
  : undefined;
export const defaultAppDeps: AppDeps = { ...defaultDeps, readMailbox: mailboxReader };

export function createApp(db: DB, deps: AppDeps = defaultAppDeps) {
  const app = express();
  // A request that fails unexpectedly is kept and, when an alert channel is set, reported (core/alerts.ts).
  setProblemReporter((err, req) => {
    void recordProblem(db, {
      source: `${req.method} ${req.originalUrl.split('?')[0]}`, message: (err as Error)?.message ?? String(err),
      detail: (err as Error)?.stack ?? null, userId: req.user?.id ?? null,
    });
  });
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  // PGlite returns int8 as BigInt; JSON cannot carry that.
  app.set('json replacer', (_k: string, v: unknown) => (typeof v === 'bigint' ? Number(v) : v));
  app.use((_req, res, next) => {
    const send = res.json.bind(res);
    res.json = (body: unknown) => send(snakeKeys(body));
    next();
  });
  app.use(helmet());
  // The exact bytes are kept as well as the parsed body: Meta's webhook signature is computed over them.
  app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // ---- 1. public: no sign-in, so limited per address (PRD section 9) ----
  const publicLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false,
    skip: () => config.env === 'test' });
  app.use('/api/public/shares', publicLimiter, publicSharesRouter(db));
  app.use('/api/public/invoices', publicLimiter, publicInvoiceRouter(db));
  app.use('/api/public/payslips', publicLimiter, publicPayslipRouter(db));
  app.use('/api/public/estimates', publicLimiter, publicEstimateRouter(db));
  app.use('/api/public', publicLimiter, publicLeadsRouter(db));

  // ---- 2. webhooks: no sign-in, each request proves itself with a signature or a key ----
  // Lead capture from Meta, Google, WhatsApp and website forms, online orders from Shopify, and the
  // scheduler that asks for the statements mailbox to be read. Their servers send in bursts, so the
  // limit is far looser than for people.
  const hookLimiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false,
    skip: () => config.env === 'test' });
  app.use('/api/hooks/bank-mail', hookLimiter, bankMailHookRouter(db, deps));
  app.use('/api/hooks/jobs', hookLimiter, jobsHookRouter(db, deps));
  app.use('/api/hooks/form', express.urlencoded({ extended: false, limit: '100kb' }));
  app.use('/api/hooks', hookLimiter, hooksRouter(db, deps));

  // ---- 3 to 5. who is asking ----
  app.use('/api', sameOriginOnly, authenticate(db));
  app.use('/api/auth', authRouter(db));
  // Everything below needs a signed-in user; each route then names its own permission.
  app.use('/api', requireAuth);
  // A save repeated with the same key (a double click, a retry) is done once (lib/idempotency.ts).
  app.use('/api', idempotent(db));

  // ---- 6. the modules ----
  // Cost price only for costs:read (lib/http.ts hideCosts). On the stock screens a plain value is stock at cost.
  app.use(['/api/items', '/api/sales', '/api/purchasing', '/api/masters'], hideCosts());
  app.use('/api/stock', hideCosts(['value', 'total_value']));
  // Admin and masters
  app.use('/api/files', filesRouter(db));
  app.use('/api/users', usersRouter(db));
  app.use('/api/settings/health', healthRouter(db));
  app.use('/api/settings', settingsRouter(db));
  app.use('/api/masters', mastersRouter(db));
  app.use('/api/items', itemsRouter(db));
  app.use('/api/parties', partiesRouter(db));
  // CRM
  app.use('/api/leads', sharesRouter(db));
  app.use('/api/leads', leadToolsRouter(db));
  app.use('/api/leads', leadsRouter(db));
  app.use('/api/crm', crmRouter(db, deps));
  // Test rides and bookings for vehicles (the leads' pipeline).
  app.use('/api/pipeline', pipelineRouter(db));
  // Sales
  app.use('/api/sales/online', onlineRouter(db, deps));
  app.use('/api/sales', reservationsRouter(db));
  app.use('/api/sales', salesRouter(db));
  // Stores
  app.use('/api/purchasing', purchasingRouter(db));
  app.use('/api/stock', inventoryRouter(db));
  app.use('/api/jobwork', jobWorkRouter(db));
  app.use('/api/imports', importsRouter(db));
  app.use('/api/units', unitsRouter(db));
  // The workshop. What a fitted part cost stays with costs:read, as everywhere else.
  app.use('/api/service', hideCosts(['issued_value']));
  app.use('/api/service', serviceRouter(db));
  // Accounts
  app.use('/api/payments', collectRouter(db));
  app.use('/api/payments', paymentsRouter(db));
  app.use('/api/accounting', accountingRouter(db));
  app.use('/api/bank', bankMailRouter(db, deps));
  app.use('/api/bank', bankRouter(db));
  app.use('/api/gst', gstRouter(db));
  app.use('/api/tds', tdsRouter(db));
  app.use('/api/opening', openingRouter(db));
  // HR
  app.use('/api/payroll/my-payslips', myPayslipRouter(db));
  app.use('/api/payroll', payrollRouter(db));
  app.use('/api/hr', hrSelfRouter(db));
  app.use('/api/hr', hrRouter(db));
  // Operations
  app.use('/api/ops', opsRouter(db));
  app.use('/api/ops', projectsRouter(db));
  // Read-only
  app.use('/api/dashboards', dashboardsRouter(db));

  // ---- 7. nothing matched, or something was thrown ----
  app.use('/api', () => {
    throw new AppError(404, 'not_found', 'No such API route');
  });
  app.use(errorHandler);
  return app;
}
