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

/**
 * Sign-in and permissions.
 *
 * A session is a random token kept in an HttpOnly cookie; the database holds only its hash.
 *   authenticate   turns the cookie into req.user on every request (it never refuses)
 *   requireAuth    refuses a request that has no signed-in user
 *   requirePerm    refuses unless the user's role holds one of the permissions named
 *
 * Which role holds which permission is one table, PERMISSIONS in packages/shared/src/constants.ts,
 * which an admin can change on screen (see core/settings.ts, loadPermissionOverrides).
 */

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// Cost 12 in real use; tests drop it so the suite is not spent hashing.
const ROUNDS = Number(process.env.BCRYPT_ROUNDS ?? 12);
export const hashPassword = (plain: string) => bcrypt.hash(plain, ROUNDS);

// Compared against when the user does not exist, so login timing does not reveal who has an account.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', ROUNDS);

/** Check a phone or email and password, and start a session. The same error whatever was wrong, so it cannot be used to find out who has an account. */
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

/** Sign a person out everywhere: used when their password or role changes, or they are switched off. */
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

/**
 * Loads req.user from the HttpOnly session cookie. Does not reject; see requireAuth.
 * A sign-in in use stays signed in: once past half its life it is renewed for a full term (technical review,
 * 26 Oct 2026: a sign-in that ran out in the middle of someone's work lost what they had typed). One left
 * unused for SESSION_TTL_DAYS still ends.
 */
export function authenticate(db: DB) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[config.cookieName];
    if (token) {
      const [row] = await db
        .select({ id: users.id, name: users.name, role: users.role, phone: users.phone, expiresAt: sessions.expiresAt })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date()), eq(users.active, true)));
      if (row) {
        const { expiresAt, ...user } = row;
        req.user = user;
        const term = config.sessionTtlDays * 86400_000;
        if (expiresAt.getTime() - Date.now() < term / 2) {
          await db.update(sessions).set({ expiresAt: new Date(Date.now() + term) }).where(eq(sessions.tokenHash, sha256(token)));
          setSessionCookie(res, token);
        }
      }
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
