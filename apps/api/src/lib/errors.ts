import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { config } from '../config';

/**
 * Errors. Code anywhere in the API throws and nothing in between catches: errorHandler, mounted
 * last in app.ts, turns whatever was thrown into the one shape the screens expect,
 *   { error: { code, message, details? } }
 * Throw an AppError (or one of the helpers below) for anything the person can act on, in words
 * they can act on. Failed zod checks and the rules the database itself enforces are put into the
 * same shape here, so a route never has to.
 */

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

type PgishError = { code?: string; message?: string; detail?: string; constraint?: string; column?: string; cause?: unknown };

function pgError(err: unknown): PgishError | null {
  let e = err as PgishError | undefined;
  for (let i = 0; i < 4 && e; i++) {
    if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e;
    e = e.cause as PgishError | undefined;
  }
  return null;
}

/**
 * A unique rule broken, in plain words. Postgres says `Key (code)=(BRD-01) already exists.`;
 * people see "There is already one with code BRD-01." (column names read as words).
 */
function duplicateMessage(pg: PgishError): string {
  const m = /^Key \((.+)\)=\((.*)\) already exists\.?$/.exec(pg.detail ?? '');
  if (!m) return 'That is already there; it cannot be added twice.';
  return `There is already one with ${m[1]!.replace(/lower\((\w+)\)/g, '$1').replace(/_id\b/g, '').replace(/_/g, ' ')} ${m[2]}.`;
}

/**
 * Database errors that are the request's fault (or a moment's bad luck), each as status, code and
 * what to tell the person. The RC codes are RadCore's own rules (raised by the triggers in the
 * migrations), whose messages are already written for people, so those go out as they are.
 */
const PG_ANSWERS: Record<string, [number, string, ((pg: PgishError) => string)?]> = {
  '23505': [409, 'duplicate', duplicateMessage],
  '23503': [409, 'reference_error', (pg) => (/still referenced/.test(pg.detail ?? '')
    ? 'This is in use elsewhere, so it cannot be removed.'
    : 'Something this points to does not exist (it may have been removed).')],
  '23514': [400, 'constraint_violation', (pg) => `Rule violated: ${pg.constraint ?? pg.message}`],
  '23502': [400, 'constraint_violation', (pg) => `${pg.column ? pg.column.replace(/_id$/, '').replace(/_/g, ' ') : 'Something'} is needed.`],
  '22P02': [400, 'bad_request', () => 'Something sent is not in the form expected (an id, a number or a date).'],
  '22003': [400, 'out_of_range', () => 'A figure is too large to keep: amounts go up to 99,99,99,999.99 and quantities up to 99,99,99,999.999.'],
  // Two people saving at the same moment, and the database chose this one to go again.
  '40001': [409, 'try_again', () => 'Someone else was saving the same thing at that moment. Please try again.'],
  '40P01': [409, 'try_again', () => 'Someone else was saving the same thing at that moment. Please try again.'],
  RC001: [409, 'append_only'],
  RC002: [500, 'unbalanced_journal'],
  RC003: [409, 'period_locked'],
  RC004: [409, 'immutable_document'],
};

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
  const hit = pg && PG_ANSWERS[pg.code ?? ''];
  if (pg && hit) {
    const [status, code, say] = hit;
    res.status(status).json({ error: { code, message: say ? say(pg) : (pg.message ?? 'Database rule violated') } });
    return;
  }
  if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'bad_request', message: 'Request body is not valid JSON' } });
    return;
  }
  if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'too_large', message: `That is too large. An attached file can be up to ${Math.floor(config.maxUploadBytes / 1024 / 1024)} MB; a statement or import file up to 1 MB at a time.` } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
}
