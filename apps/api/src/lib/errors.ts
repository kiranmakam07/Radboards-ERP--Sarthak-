import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Please sign in') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do this') =>
  new AppError(403, 'forbidden', message);
export const notFound = (what = 'Record') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'conflict', message, details);

/** Throw 404 when a lookup came back empty. */
export function must<T>(value: T | undefined | null, what = 'Record'): T {
  if (value === undefined || value === null) throw notFound(what);
  return value;
}

type PgishError = { code?: string; message?: string; detail?: string; constraint?: string; cause?: unknown };

function pgError(err: unknown): PgishError | null {
  let e = err as PgishError | undefined;
  for (let i = 0; i < 4 && e; i++) {
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e;
    e = e.cause as PgishError | undefined;
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    const first = issues[0];
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: first ? `${first.path ? `${first.path}: ` : ''}${first.message}` : 'Invalid input',
        details: issues,
      },
    });
    return;
  }
  const pg = pgError(err);
  if (pg) {
    const map: Record<string, [number, string]> = {
      '23505': [409, 'duplicate'],
      '23503': [409, 'reference_error'],
      '23514': [400, 'constraint_violation'],
      '23502': [400, 'constraint_violation'],
      '22P02': [400, 'bad_request'],
      RC001: [409, 'append_only'],
      RC002: [500, 'unbalanced_journal'],
      RC003: [409, 'period_locked'],
      RC004: [409, 'immutable_document'],
    };
    const hit = map[pg.code ?? ''];
    if (hit) {
      const message =
        pg.code === '23505'
          ? `Duplicate value: ${pg.detail ?? pg.constraint ?? pg.message}`
          : pg.code === '23514'
            ? `Rule violated: ${pg.constraint ?? pg.message}`
            : (pg.message ?? 'Database rule violated');
      res.status(hit[0]).json({ error: { code: hit[1], message } });
      return;
    }
  }
  if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'bad_request', message: 'Request body is not valid JSON' } });
    return;
  }
  if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'too_large', message: 'That is too large. An attached file can be up to 10 MB; a statement or import file up to 1 MB at a time.' } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
}
