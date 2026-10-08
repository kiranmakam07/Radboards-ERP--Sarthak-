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
import { dashboardsRouter } from './modules/dashboards';
import { gstRouter } from './modules/gst';
import { inventoryRouter } from './modules/inventory';
import { itemsRouter } from './modules/items';
import { leadsRouter, publicLeadsRouter } from './modules/leads';
import { partiesRouter } from './modules/parties';
import { paymentsRouter } from './modules/payments';
import { purchasingRouter } from './modules/purchasing';
import { salesRouter } from './modules/sales';

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

export function createApp(db: DB) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // PGlite returns int8 as BigInt; JSON cannot carry that.
  app.set('json replacer', (_k: string, v: unknown) => (typeof v === 'bigint' ? Number(v) : v));
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Public enquiry forms: no login, so rate-limited per IP (PRD section 9).
  const publicLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false,
    skip: () => config.env === 'test' });
  app.use('/api/public', publicLimiter, publicLeadsRouter(db));

  app.use('/api', sameOriginOnly, authenticate(db));
  app.use('/api/auth', authRouter(db));

  // Everything below needs a signed-in user; each route then names its own permission.
  app.use('/api', requireAuth);
  app.use('/api/users', usersRouter(db));
  app.use('/api/settings', settingsRouter(db));
  app.use('/api/masters', mastersRouter(db));
  app.use('/api/items', itemsRouter(db));
  app.use('/api/parties', partiesRouter(db));
  app.use('/api/leads', leadsRouter(db));
  app.use('/api/sales', salesRouter(db));
  app.use('/api/payments', paymentsRouter(db));
  app.use('/api/purchasing', purchasingRouter(db));
  app.use('/api/stock', inventoryRouter(db));
  app.use('/api/accounting', accountingRouter(db));
  app.use('/api/gst', gstRouter(db));
  app.use('/api/dashboards', dashboardsRouter(db));

  app.use('/api', () => {
    throw new AppError(404, 'not_found', 'No such API route');
  });
  app.use(errorHandler);
  return app;
}
