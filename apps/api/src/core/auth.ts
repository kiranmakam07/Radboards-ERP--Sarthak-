import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, eq, gt, lt, or } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import { can, normalisePhone, type Permission } from '@radcore/shared';
import { config } from '../config';
import type { DB } from '../db/client';
import { sessions, users } from '../db/schema';
import { forbidden, unauthorized } from '../lib/errors';
import type { AuthUser } from '../lib/http';

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// Cost 12 in real use; tests drop it so the suite is not spent hashing.
const ROUNDS = Number(process.env.BCRYPT_ROUNDS ?? 12);
export const hashPassword = (plain: string) => bcrypt.hash(plain, ROUNDS);

// Compared against when the user does not exist, so login timing does not reveal who has an account.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', ROUNDS);

export async function login(db: DB, identifier: string, password: string): Promise<{ token: string; user: AuthUser }> {
  const phone = normalisePhone(identifier);
  const email = identifier.trim().toLowerCase();
  const [user] = await db
    .select()
    .from(users)
    .where(phone ? or(eq(users.phone, phone), eq(users.email, email)) : eq(users.email, email));
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok || !user.active) throw unauthorized('Wrong phone/email or password');

  // Only a hash of the token is stored: a leaked database cannot be replayed as sessions.
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 86400_000);
  await db.insert(sessions).values({ tokenHash: sha256(token), userId: user.id, expiresAt });
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  return { token, user: { id: user.id, name: user.name, role: user.role, phone: user.phone } };
}

export async function logout(db: DB, token: string | undefined): Promise<void> {
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
}

export async function revokeUserSessions(db: DB, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: config.sessionTtlDays * 86400_000,
    path: '/',
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(config.cookieName, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' });
}

/** Loads req.user from the HttpOnly session cookie. Does not reject; see requireAuth. */
export function authenticate(db: DB) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[config.cookieName];
    if (token) {
      const [row] = await db
        .select({ id: users.id, name: users.name, role: users.role, phone: users.phone })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date()), eq(users.active, true)));
      if (row) req.user = row;
    }
    next();
  };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) throw unauthorized();
  next();
}

/** Role-based access (PRD 7.13): the route names the permission, the matrix decides. */
export function requirePerm(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw unauthorized();
    if (!permissions.some((p) => can(req.user!.role, p))) throw forbidden();
    next();
  };
}
