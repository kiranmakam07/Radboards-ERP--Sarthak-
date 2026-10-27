'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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

// ---- signed out in the middle of work ----------------------------------------------------------
// Once the app has loaded a sign-in, a 401 no longer sends the browser to the sign-in page, which would lose what
// someone was typing (technical review, 26 Oct 2026). The frame (app/(app)/layout.tsx) asks for the password in
// place instead; the screen and what was typed stay, and the save is pressed again.
let signedIn = false;
export const markSignedIn = () => {
  signedIn = true;
};
export const SIGNED_OUT_EVENT = 'radcore:signed-out';

// ---- one save, done once ------------------------------------------------------------------------
// Each save carries an Idempotency-Key, the same for every attempt of that one save (a second click, a retry after
// the answer was lost), so the API does it once (technical review, 26 Oct 2026; apps/api/src/lib/idempotency.ts).
// Form, ActionButton and the save buttons that call the API themselves hold a key for their save and run their
// call inside withSaveKey; a save that needs several requests numbers them, so a retry sends the same keys again.
let ambient: { key: string; n: number } | null = null;

/** A new key for a new save. */
export const newSaveKey = (): string =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);

/** Run a save with its key. The requests it starts straight away (before any await) carry the key. */
export function withSaveKey<T>(key: string, run: () => T): T {
  const before = ambient;
  ambient = { key, n: 0 };
  try {
    return run();
  } finally {
    ambient = before;
  }
}

/**
 * For a save button that calls the API itself rather than through Form or ActionButton: one save at a time, sent
 * with its key, so a double click does not save twice (code review, 27 Oct 2026: credit notes, manual journals,
 * deliveries, stock transfers and fitted parts could each be saved twice by a quick second click).
 *   const saving = useSaving();
 *   <button disabled={saving.busy} onClick={() => saving.run(save)}>
 * The handler keeps catching and showing its own errors. A new key is taken after each save, so the next one is new.
 */
export function useSaving() {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const key = useRef(newSaveKey());
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await withSaveKey(key.current, fn);
    } finally {
      key.current = newSaveKey();
      running.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, run };
}

/** Call the API (proxied under /api by Next). Throws ApiError with the server's message. */
export async function api<T = any>(path: string, opts: Options = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const saveKey = method !== 'GET' && ambient ? `${ambient.key}-${++ambient.n}` : null;
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(saveKey ? { 'Idempotency-Key': saveKey } : {}),
    },
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
    if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login') && !path.startsWith('/auth/login')) {
      if (signedIn) window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
      else window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
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
  const p: Promise<T> = api<T>(withLimit(path))
    .then((d) => {
      const list = d as { data?: unknown; more?: boolean; limit?: number };
      if (list?.more && list.data && typeof list.data === 'object') cutShort.set(list.data, { path, limit: list.limit ?? 100 });
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

// ---- long lists ---------------------------------------------------------------------------------
// A list the API cut short says so (more: true, with the limit it used). The table showing it then says how many
// it shows and offers more (components/ui.tsx Table), instead of stopping at 100 rows without a word (technical
// review, 26 Oct 2026). Asking for more raises the limit for that list's path, and every screen part showing it
// loads it again. The largest list the API gives is 5,000 rows; beyond that, the search and filters narrow it.
const raised = new Map<string, number>();
const cutShort = new WeakMap<object, { path: string; limit: number }>();
const moreListeners = new Set<(path: string) => void>();
const withLimit = (path: string) => {
  const limit = raised.get(path);
  return limit ? `${path}${path.includes('?') ? '&' : '?'}limit=${limit}` : path;
};
/** Whether these rows are a list the API cut short, and which list. */
export const cutShortInfo = (rows: unknown) => (rows && typeof rows === 'object' ? cutShort.get(rows) : undefined);
export const MAX_LIST = 5000;
/** Load more of a list that was cut short. */
export function showMore(path: string, current: number) {
  raised.set(path, Math.min(MAX_LIST, current * 5));
  moreListeners.forEach((l) => l(path));
}

/** What the screen last loaded from a path, if it has (for a button that depends on what is on screen). */
export const lastLoaded = <T = any>(path: string): T | undefined => seen<T>(path);

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
  // "Show more" on this list, from the table showing it: load it again with the higher limit.
  useEffect(() => {
    if (!path) return;
    const listener = (p: string) => {
      if (p === path) setTick((t) => t + 1);
    };
    moreListeners.add(listener);
    return () => {
      moreListeners.delete(listener);
    };
  }, [path]);
  return { data, error, loading, reload };
}

/** Build a query string, skipping empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v !== null && v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
