import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { can, D, type Decimal, GST_RATES, isIsoDate, isValidGstin, normaliseGstin, normalisePhone, type Permission, type Role } from '@radcore/shared';
import type { DB } from '../db/client';
import { AppError } from './errors';
import { toXlsx } from './xlsx';

/**
 * What every route is built from.
 *   Ctx, inTx     one request is one database transaction, and every service function is told
 *                 which transaction it is in and who is acting
 *   the z* checks money, quantities, dates, phone numbers and GSTINs are read from a request the
 *                 same way everywhere; money and quantities stay as text, never floating point
 *   sendList      any list or report as JSON, or as a CSV or Excel file with ?format=
 *   hideCosts     what stock cost us stays with the roles that hold costs:read
 */

export type AuthUser = { id: string; name: string; role: Role; phone: string };

/** What every service function receives: the open transaction and who is acting. */
export type Ctx = { tx: DB; user: AuthUser | null };

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

/** Run a request's work in ONE database transaction (PRD section 9: data integrity). */
export function inTx<T>(db: DB, req: Request, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  return db.transaction((tx) => fn({ tx: tx as unknown as DB, user: req.user ?? null }));
}

export const userId = (ctx: Ctx): string | null => ctx.user?.id ?? null;

// ---- zod building blocks ---------------------------------------------------
const decimalString = (maxDp: number) =>
  z.union([z.string(), z.number()]).transform((v, c) => {
    const s = String(v).trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) {
      c.addIssue({ code: 'custom', message: 'must be a number' });
      return z.NEVER;
    }
    const dp = s.includes('.') ? (s.split('.')[1] ?? '').replace(/0+$/, '').length : 0;
    if (dp > maxDp) {
      c.addIssue({ code: 'custom', message: `at most ${maxDp} decimal places` });
      return z.NEVER;
    }
    return D(s).toFixed(maxDp);
  });

/**
 * A rule about the size of a number, judged only on a value the number check above let through: zod
 * still runs later rules after that check has failed (handing them its "no value" marker), and taking
 * that marker as a number would crash the request instead of answering "must be a number".
 */
export const sized = (rule: (d: Decimal) => boolean) => (v: unknown) => typeof v !== 'string' || !/^-?\d+(\.\d+)?$/.test(v) || rule(D(v));

// The largest figure each column can keep (money numeric(12,2), quantities numeric(12,3)).
const moneyFits = sized((d) => d.abs().lt('10000000000'));
const qtyFits = sized((d) => d.abs().lt('1000000000'));

export const zId = z.string().uuid();
export const zMoney = decimalString(2).refine(sized((d) => d.gte(0)), 'cannot be negative').refine(moneyFits, 'too large');
export const zMoneyPos = zMoney.refine(sized((d) => d.gt(0)), 'must be more than 0');
export const zSignedMoney = decimalString(2).refine(moneyFits, 'too large');
export const zQty = decimalString(3).refine(sized((d) => d.gt(0)), 'must be more than 0').refine(qtyFits, 'too large');
export const zQtyNonNeg = decimalString(3).refine(sized((d) => d.gte(0)), 'cannot be negative').refine(qtyFits, 'too large');
export const zSignedQty = decimalString(3).refine(qtyFits, 'too large');
/** Kg for one unit of an item (spreading an import's freight by weight). */
export const zWeight = decimalString(3).refine(sized((d) => d.gt(0) && d.lt(1_000_000)), 'must be more than 0 and under 10 lakh kg');
export const zGstRate = z.union([z.string(), z.number()]).transform((v, c) => {
  const n = Number(v);
  if (!(GST_RATES as readonly number[]).includes(n)) {
    c.addIssue({ code: 'custom', message: `GST rate must be one of ${GST_RATES.join(', ')}` });
    return z.NEVER;
  }
  return n.toFixed(2);
});
/** A currency code (ISO 4217, three letters), rupees unless given. */
export const zCurrency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'must be a 3-letter currency code like USD').default('INR');
/** Rupees for one unit of a foreign currency, up to 6 decimals. */
export const zFxRate = decimalString(6).refine(sized((d) => d.gt(0) && d.lt(1000000)), 'must be more than 0');

/**
 * The currency and rate a document is in: rupees at 1, or a foreign currency at the rate given
 * (required then). Returns the rate as text, ready to store.
 */
export function fxOf(currency: string, fxRate: string | null | undefined): { currency: string; fxRate: string } {
  if (currency === 'INR') {
    if (fxRate && !D(fxRate).eq(1)) throw new AppError(400, 'bad_request', 'A rupee amount has an exchange rate of 1');
    return { currency, fxRate: '1' };
  }
  if (!fxRate) throw new AppError(400, 'bad_request', `Give the exchange rate: rupees for one ${currency}`);
  return { currency, fxRate };
}

/** Serial numbers typed or scanned for a serialised item, one per unit. */
export const zSerials = z.array(z.string().trim().min(1, 'a serial cannot be blank').max(60)).max(1000);
/** Compensation cess, % of the taxable value. */
export const zCessRate = decimalString(2).refine(sized((d) => d.gte(0) && d.lte(500)), 'must be between 0 and 500');
export const zDate = z.string().refine(isIsoDate, 'must be a date (YYYY-MM-DD)');
/** A calendar month, as payroll and TDS name one. */
export const zMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be a month (YYYY-MM)');
/** A time of day as HH:MM (24-hour). */
export const zClock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a time like 09:30');
export const zPhone = z.string().transform((v, c) => {
  const p = normalisePhone(v);
  if (!p) {
    c.addIssue({ code: 'custom', message: 'must be a valid 10-digit Indian mobile number' });
    return z.NEVER;
  }
  return p;
});
export const zGstin = z.string().transform((v, c) => {
  const g = normaliseGstin(v);
  if (!isValidGstin(g)) {
    c.addIssue({ code: 'custom', message: 'is not a valid GSTIN (format/checksum)' });
    return z.NEVER;
  }
  return g;
});
export const zStateCode = z.string().regex(/^\d{2}$/, 'must be a 2-digit state code');
export const zAddress = z.object({
  line1: z.string().max(200).optional().default(''),
  line2: z.string().max(200).optional().default(''),
  city: z.string().max(100).optional().default(''),
  state: z.string().max(100).optional().default(''),
  pincode: z.string().max(10).optional().default(''),
});
/** Treat "" as "not provided" so simple HTML forms can post empty fields. */
export const emptyToNull = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' || v === undefined ? null : v), schema.nullable());
export const zText = (max = 500) => z.string().trim().min(1).max(max);
/** Links shown in the UI must be plain web links - never javascript: or data: URLs. */
export const zHttpUrl = z.string().trim().max(1000).url().refine((u) => /^https?:\/\//i.test(u), 'must start with http:// or https://');

/** A link shown in the UI: a web link, or a file attached here (/api/files/<id>). Never javascript: or data:. */
export const zLink = z.string().trim().max(1000).refine(
  (u) => /^\/api\/files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(u) || (/^https?:\/\//i.test(u) && URL.canParse(u)),
  'must be an attached file or a link starting with http:// or https://',
);

export const zListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  format: z.enum(['json', 'csv', 'xlsx']).default('json'),
});

// ---- responses --------------------------------------------------------------
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Stop spreadsheet formula injection from user-entered text.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(data: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? Object.keys(data[0] ?? {});
  const lines = [cols.join(',')];
  for (const row of data) lines.push(cols.map((c) => csvCell(row[c])).join(','));
  return lines.join('\r\n');
}

/** True when the caller asked for a file to download rather than JSON. */
export const wantsFile = (req: Request): boolean => req.query.format === 'csv' || req.query.format === 'xlsx';

// ---------------------------------------------------------------------------
// Cost price: what stock cost us is for the people who buy it, keep it and keep the books
// (costs:read: owner, stores, accounts, admin). Sales, the counter and marketing work from selling
// prices, so for them these keys are taken out of every answer of the routers that carry them
// (app.ts mounts hideCosts in front of items, sales, purchasing, masters and stock), files included.
// ---------------------------------------------------------------------------
export const COST_KEYS = ['purchase_cost', 'unit_cost', 'avg_cost', 'valuation', 'cogs', 'margin', 'margin_pct'] as const;

const snakeKey = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** A copy of a JSON-like value without the named keys at any depth; a key matches in camelCase or snake_case. */
export function withoutKeys(value: unknown, keys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => withoutKeys(v, keys));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!keys.has(snakeKey(k))) out[k] = withoutKeys(v, keys);
    return out;
  }
  return value;
}

/** Whether the signed-in user may see cost price. */
export const seesCosts = (req: Request): boolean => !!req.user && can(req.user.role, 'costs:read');

/**
 * Middleware: for a user without costs:read, every answer below it leaves out COST_KEYS and the
 * `extra` keys (on the stock screens a plain `value` is stock at cost, so it goes too).
 */
export function hideCosts(extra: string[] = []) {
  const keys: ReadonlySet<string> = new Set<string>([...COST_KEYS, ...extra]);
  return (req: Request, res: Response, next: NextFunction) => {
    if (seesCosts(req)) return next();
    const send = res.json.bind(res);
    res.json = (body: unknown) => send(withoutKeys(body, keys));
    res.locals.hiddenKeys = keys;
    next();
  };
}

/** Every list/report can be exported with ?format=csv or ?format=xlsx (PRD 7.11). */
export function sendList(req: Request, res: Response, rowsIn: Record<string, unknown>[], name = 'export') {
  // A file skips res.json, so the keys hideCosts hides are taken out here as well.
  const hidden = res.locals.hiddenKeys as ReadonlySet<string> | undefined;
  const data = hidden ? (withoutKeys(rowsIn, hidden) as Record<string, unknown>[]) : rowsIn;
  if (req.query.format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    res.send(toXlsx(data, undefined, name));
    return;
  }
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    res.send(`﻿${toCsv(data)}`);
    return;
  }
  res.json({ data });
}

export type { Permission };
