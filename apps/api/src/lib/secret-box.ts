import crypto from 'node:crypto';
import { config } from '../config';
import { AppError } from './errors';

/**
 * Keeps a secret the system must be able to read back (a bank statement's password) in the
 * database without it being readable there: it is locked with a key made from APP_SECRET, which
 * lives on the server and never in the database. Whoever has only a copy of the database cannot
 * open it. (Sign-in passwords are different: they are never read back, so they are only hashed.)
 */

/**
 * The key, made from APP_SECRET. scrypt is slow on purpose and blocks while it works, so the key is made once and
 * kept, and made again only if APP_SECRET changes (code review, 27 Oct 2026).
 */
let made: { secret: string; key: Buffer } | null = null;
const key = (): Buffer => {
  if (made?.secret !== config.appSecret) made = { secret: config.appSecret, key: crypto.scryptSync(config.appSecret, 'radcore-secret-box-v1', 32) };
  return made.key;
};

/** True when the server has been given a key to lock secrets with. */
export const canSeal = (): boolean => config.appSecret.length >= 24;

export function seal(text: string): string {
  if (!canSeal()) {
    throw new AppError(409, 'no_app_secret',
      'A password can only be saved once APP_SECRET is set on the server (a long random text, at least 24 characters). Until then, type the password each time.');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}

/** The secret, or null when it cannot be opened (APP_SECRET changed, or the value was tampered with). */
export function unseal(sealed: string | null | undefined): string | null {
  if (!sealed || !canSeal()) return null;
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !body) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
