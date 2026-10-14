'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * The one way a screen talks to the API.
 *
 *   useGet('/sales/orders')            load data for a page; gives { data, error, loading, reload }
 *   post / put / patch('/path', body)  change something; throws ApiError with the server's own message
 *   qs({ from, to })                   build a query string, leaving out what is blank
 *
 * Every call goes to /api on this same origin, so the session cookie travels with it. A 401 sends
 * the browser to the sign-in page and back again afterwards. Names in requests and responses are
 * snake_case, the same as the database columns.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Options = { method?: string; body?: unknown };

/** Call the API (proxied under /api by Next). Throws ApiError with the server's message. */
export async function api<T = any>(path: string, opts: Options = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON (e.g. the API is down and the proxy returned HTML) */
  }
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    }
    const e = json?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status}). Is the API running?`, e?.details);
  }
  return json as T;
}

export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const put = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'PUT', body });
export const patch = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'PATCH', body });

// ---- remembered answers ------------------------------------------------------------------------
// What each GET last returned, kept in memory for this visit only (signing out reloads the page, which
// forgets it all). A screen opened again shows its last answer at once and asks afresh behind it, and
// the same GET wanted by two pieces of a screen at the same moment goes to the server once.
const remembered = new Map<string, unknown>();
const inFlight = new Map<string, Promise<unknown>>();
const REMEMBER_AT_MOST = 200;

function remember(path: string, data: unknown) {
  remembered.delete(path);
  remembered.set(path, data);
  // The oldest answers go first; a Map keeps the order things were put in.
  if (remembered.size > REMEMBER_AT_MOST) remembered.delete(remembered.keys().next().value as string);
}

/** GET a path, sharing a request already on its way unless `fresh` (after a change, the old one may be out of date). */
function load<T>(path: string, fresh: boolean): Promise<T> {
  const running = inFlight.get(path);
  if (running && !fresh) return running as Promise<T>;
  const p: Promise<T> = api<T>(path)
    .then((d) => {
      remember(path, d);
      return d;
    })
    .finally(() => {
      if (inFlight.get(path) === p) inFlight.delete(path);
    });
  inFlight.set(path, p);
  return p;
}

const seen = <T>(path: string | null) => (path && typeof window !== 'undefined' ? (remembered.get(path) as T | undefined) : undefined);

/**
 * Load data for a page. Pass null to skip. `reload()` refetches after a change. `loading` is true
 * only while there is nothing to show yet: a remembered answer is shown while the new one comes.
 */
export function useGet<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(() => seen<T>(path) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path) && seen<T>(path) === undefined);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    const last = seen<T>(path);
    if (last !== undefined) {
      setData(last);
      setLoading(false);
    } else {
      setLoading(true);
    }
    load<T>(path, tick > 0)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/** Build a query string, skipping empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v !== null && v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
