import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { config } from './config';
import { authenticate, requireAuth } from './core/auth';
import type { DB } from './db/client';
import { AppError, errorHandler, forbidden } from './lib/errors';
import { accountingRouter } from './modules/accounting';
import { authRouter, mastersRouter, settingsRouter, usersRouter } from './modules/admin';
import { bankRouter } from './modules/bank';
import { collectRouter, publicInvoiceRouter } from './modules/collect';
import { crmRouter, defaultDeps, hooksRouter, type CrmDeps } from './modules/crm';
import { dashboardsRouter } from './modules/dashboards';
import { filesRouter } from './modules/files';
import { gstRouter } from './modules/gst';
import { tdsRouter } from './modules/tds';
import { hrRouter } from './modules/hr';
import { hrSelfRouter } from './modules/hr-self';
import { inventoryRouter } from './modules/inventory';
import { itemsRouter } from './modules/items';
import { leadToolsRouter } from './modules/lead-tools';
import { leadsRouter, publicLeadsRouter } from './modules/leads';
import { onlineRouter } from './modules/online-router';
import { opsRouter } from './modules/ops';
import { partiesRouter } from './modules/parties';
import { paymentsRouter } from './modules/payments';
import { myPayslipRouter, payrollRouter, publicPayslipRouter } from './modules/payroll';
import { projectsRouter } from './modules/projects';
import { purchasingRouter } from './modules/purchasing';
import { salesRouter } from './modules/sales';
import { publicSharesRouter, sharesRouter } from './modules/shares';

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

/**
 * The API speaks snake_case everywhere (same names as the database columns in the PRD),
 * for requests and responses alike, and every timestamp goes out as ISO-8601 UTC. Rows
 * come back from the ORM in camelCase and from raw SQL in PostgreSQL's own formats; both
 * are normalised here, in one place.
 */
// PostgreSQL prints timestamptz as "2026-10-08 03:32:08.575+00"; browsers need ISO-8601.
const PG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/;

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

export function createApp(db: DB, crmDeps: CrmDeps = defaultDeps) {
  const app = express();
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

  // Public enquiry forms: no login, so rate-limited per IP (PRD section 9).
  const publicLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false,
    skip: () => config.env === 'test' });
  app.use('/api/public/shares', publicLimiter, publicSharesRouter(db));
  app.use('/api/public/invoices', publicLimiter, publicInvoiceRouter(db));
  app.use('/api/public/payslips', publicLimiter, publicPayslipRouter(db));
  app.use('/api/public', publicLimiter, publicLeadsRouter(db));

  // Lead capture from Meta, Google, WhatsApp and website forms: no login, each request proves itself
  // with a signature or a key. Their servers send in bursts, so the limit is far looser than for people.
  const hookLimiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false,
    skip: () => config.env === 'test' });
  app.use('/api/hooks/form', express.urlencoded({ extended: false, limit: '100kb' }));
  app.use('/api/hooks', hookLimiter, hooksRouter(db, crmDeps));

  app.use('/api', sameOriginOnly, authenticate(db));
  app.use('/api/auth', authRouter(db));

  // Everything below needs a signed-in user; each route then names its own permission.
  app.use('/api', requireAuth);
  app.use('/api/files', filesRouter(db));
  app.use('/api/users', usersRouter(db));
  app.use('/api/settings', settingsRouter(db));
  app.use('/api/masters', mastersRouter(db));
  app.use('/api/items', itemsRouter(db));
  app.use('/api/parties', partiesRouter(db));
  app.use('/api/leads', sharesRouter(db));
  app.use('/api/leads', leadToolsRouter(db));
  app.use('/api/leads', leadsRouter(db));
  app.use('/api/crm', crmRouter(db, crmDeps));
  app.use('/api/sales/online', onlineRouter(db, crmDeps));
  app.use('/api/sales', salesRouter(db));
  app.use('/api/payments', collectRouter(db));
  app.use('/api/payments', paymentsRouter(db));
  app.use('/api/purchasing', purchasingRouter(db));
  app.use('/api/stock', inventoryRouter(db));
  app.use('/api/accounting', accountingRouter(db));
  app.use('/api/bank', bankRouter(db));
  app.use('/api/gst', gstRouter(db));
  app.use('/api/tds', tdsRouter(db));
  app.use('/api/payroll/my-payslips', myPayslipRouter(db));
  app.use('/api/payroll', payrollRouter(db));
  app.use('/api/hr', hrSelfRouter(db));
  app.use('/api/hr', hrRouter(db));
  app.use('/api/ops', opsRouter(db));
  app.use('/api/ops', projectsRouter(db));
  app.use('/api/dashboards', dashboardsRouter(db));

  app.use('/api', () => {
    throw new AppError(404, 'not_found', 'No such API route');
  });
  app.use(errorHandler);
  return app;
}
