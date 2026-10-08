import type { Request, Response } from 'express';
import { z } from 'zod';
import { D, isIsoDate, isValidGstin, normaliseGstin, normalisePhone, type Permission, type Role } from '@radcore/shared';
import type { DB } from '../db/client';

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

export const zId = z.string().uuid();
export const zMoney = decimalString(2).refine((v) => D(v).gte(0), 'cannot be negative')
  .refine((v) => D(v).lt('10000000000'), 'too large');
export const zMoneyPos = zMoney.refine((v) => D(v).gt(0), 'must be more than 0');
export const zSignedMoney = decimalString(2);
export const zQty = decimalString(3).refine((v) => D(v).gt(0), 'must be more than 0');
export const zQtyNonNeg = decimalString(3).refine((v) => D(v).gte(0), 'cannot be negative');
export const zSignedQty = decimalString(3);
export const zGstRate = z.union([z.string(), z.number()]).transform((v, c) => {
  const n = Number(v);
  if (![0, 5, 12, 18, 28].includes(n)) {
    c.addIssue({ code: 'custom', message: 'GST rate must be 0, 5, 12, 18 or 28' });
    return z.NEVER;
  }
  return n.toFixed(2);
});
export const zDate = z.string().refine(isIsoDate, 'must be a date (YYYY-MM-DD)');
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

export const zListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  format: z.enum(['json', 'csv']).default('json'),
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

/** Every list/report can be exported with ?format=csv (PRD 7.11). */
export function sendList(req: Request, res: Response, data: Record<string, unknown>[], name = 'export') {
  if (req.query.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    res.send(`﻿${toCsv(data)}`);
    return;
  }
  res.json({ data });
}

export type { Permission };
