import crypto from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { LEAD_STAGE_LABELS, OPEN_LEAD_STAGES, formatDate, istDate, normalisePhone } from '@radcore/shared';
import { config } from '../config';
import { audit } from '../core/audit';
import { requirePerm } from '../core/auth';
import { getSetting, setSetting } from '../core/settings';
import { rows, type DB } from '../db/client';
import { adSpends, campaigns, channelEvents, items, leadActivities, leadSources, leads, messageTemplates } from '../db/schema';
import { AppError, badRequest, conflict, forbidden, must } from '../lib/errors';
import { emptyToNull, inTx, sendList, zDate, zId, zMoneyPos, zText, wantsFile, type Ctx, zPatch } from '../lib/http';
import { captureLead, moveLead, sourceIdByName } from './leads';
import { advancePlan, stopPlan } from './plans';
import { cancelOnlineOrder, fromShopify, isOnlineChannel, takeOrder, type OnlineOrder } from './online';

/**
 * CRM connections: every outside source of enquiries ends in the same place, captureLead, so a
 * lead from a Meta ad, a Google ad, a WhatsApp message or the website is deduplicated on phone,
 * given an owner and a first follow-up exactly like one typed in by hand.
 *
 * Each incoming webhook is first stored as a channel event (so nothing is lost and a repeat
 * delivery is recognised), then turned into a lead. What could not be turned into a lead stays
 * on the Lead sources screen with the reason, and can be retried.
 */

export type CrmDeps = {
  /** GET a JSON document from the web (Meta's Graph API). Replaced by a stub in tests. */
  getJson: (url: string) => Promise<{ status: number; body: any }>;
  /** POST a JSON document to the web (sending a WhatsApp message). Replaced by a stub in tests. */
  postJson?: (url: string, body: unknown, headers: Record<string, string>) => Promise<{ status: number; body: any }>;
  /** When true the webhook answers only after the lead is created. Tests use this; live traffic is answered first. */
  awaitProcessing?: boolean;
};

export const defaultDeps: CrmDeps = {
  getJson: async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return { status: res.status, body: await res.json().catch(() => null) };
  },
  postJson: async (url, body, headers) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return { status: res.status, body: await res.json().catch(() => null) };
  },
};

type Event = typeof channelEvents.$inferSelect;
type Incoming = { name: string | null; phone: string | null; email: string | null; extras: [string, string][] };

/** The event can never become a lead as it stands (no phone number, say). Retrying will not help. */
class Unusable extends Error {}
/** Something on our side is not set up yet. Retrying after fixing it will work. */
class NotReady extends Error {}

const clean = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const isEmail = (v: string | null) => (v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v.slice(0, 200) : null);
const title = (key: string) => key.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/** Google lead form answers: [{ column_id: 'FULL_NAME', string_value: '...' }, ...] */
export function fromGoogleColumns(columns: { column_id?: string; string_value?: string }[]): Incoming {
  const get = (...ids: string[]) => clean(columns.find((c) => ids.includes(c.column_id ?? '') && clean(c.string_value))?.string_value);
  const known = ['FULL_NAME', 'FIRST_NAME', 'LAST_NAME', 'PHONE_NUMBER', 'WORK_PHONE', 'EMAIL', 'WORK_EMAIL'];
  return {
    name: get('FULL_NAME') ?? ([get('FIRST_NAME'), get('LAST_NAME')].filter(Boolean).join(' ') || null),
    phone: get('PHONE_NUMBER', 'WORK_PHONE'),
    email: isEmail(get('EMAIL', 'WORK_EMAIL')),
    extras: columns.filter((c) => c.column_id && !known.includes(c.column_id) && clean(c.string_value))
      .map((c) => [title(c.column_id!), clean(c.string_value)!]),
  };
}

/** Meta lead form answers: [{ name: 'full_name', values: ['...'] }, ...] */
export function fromMetaFields(fields: { name?: string; values?: string[] }[]): Incoming {
  const get = (...names: string[]) => clean(fields.find((f) => names.includes(f.name ?? '') && clean(f.values?.[0]))?.values?.[0]);
  const known = ['full_name', 'first_name', 'last_name', 'phone_number', 'phone', 'email'];
  return {
    name: get('full_name') ?? ([get('first_name'), get('last_name')].filter(Boolean).join(' ') || null),
    phone: get('phone_number', 'phone'),
    email: isEmail(get('email')),
    extras: fields.filter((f) => f.name && !known.includes(f.name) && clean(f.values?.[0])).map((f) => [title(f.name!), f.values!.map((v) => v.trim()).join(', ')]),
  };
}

async function capture(
  ctx: Ctx, incoming: Incoming,
  o: { sourceId: string; sourceDetail: string | null; campaignId?: string | null; externalRef: string; fallbackName: string; notes?: string | null },
) {
  const phone = normalisePhone(incoming.phone);
  if (!phone) throw new Unusable(incoming.phone ? `"${incoming.phone}" is not an Indian mobile number` : 'The enquiry has no phone number');
  const extra = incoming.extras.map(([k, v]) => `${k}: ${v}`).join('\n');
  const notes = [o.notes, extra].filter(Boolean).join('\n').slice(0, 2000) || null;
  const { lead } = await captureLead(ctx, {
    name: (incoming.name ?? o.fallbackName).slice(0, 150), phone, email: incoming.email, sourceId: o.sourceId,
    sourceDetail: o.sourceDetail?.slice(0, 200) ?? null, campaignId: o.campaignId ?? null, externalRef: o.externalRef, notes,
    // They sent this enquiry themselves (a lead form, a message): DPDP consent, and how it was given.
    consentSource: `their own enquiry${o.sourceDetail ? ` (${o.sourceDetail.slice(0, 100)})` : ''}`,
  });
  return lead;
}

type MetaLead = {
  field_data: { name: string; values: string[] }[]; campaign_name?: string; ad_name?: string; form_id?: string; form_name?: string;
  platform?: string; created_time?: string;
};

async function fetchMetaLead(deps: CrmDeps, leadgenId: string) {
  if (!config.metaPageAccessToken) throw new NotReady('The Meta page access token is not set yet (META_PAGE_ACCESS_TOKEN), so the answers of this lead form cannot be read');
  const url = `https://graph.facebook.com/${config.metaGraphVersion}/${encodeURIComponent(leadgenId)}`
    + `?fields=created_time,ad_name,adset_name,campaign_name,form_id,field_data,platform&access_token=${encodeURIComponent(config.metaPageAccessToken)}`;
  let res;
  try {
    res = await deps.getJson(url);
  } catch {
    throw new NotReady('Meta could not be reached to read this lead. Try again in a while.');
  }
  if (res.status !== 200 || !Array.isArray(res.body?.field_data)) {
    throw new NotReady(`Meta refused to hand over this lead (${res.body?.error?.message ?? `HTTP ${res.status}`}). Check the page access token and its leads_retrieval permission.`);
  }
  return res.body as MetaLead;
}

/** Text of a WhatsApp message, or a short description when it is not text. */
function whatsappText(m: any): string {
  if (m.type === 'text') return clean(m.text?.body) ?? '';
  if (m.type === 'button') return clean(m.button?.text) ?? '';
  if (m.type === 'interactive') return clean(m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title) ?? '';
  return `[${String(m.type ?? 'message')}]`;
}

/** Turn one stored event into a lead (or add it to the lead that phone number already has). */
async function handle(ctx: Ctx, e: Event, fetched: Awaited<ReturnType<typeof fetchMetaLead>> | null): Promise<{ leadId?: string | null; orderId?: string | null; summary: string }> {
  const p = e.payload as any;
  if (isOnlineChannel(e.channel)) {
    // An order from the online store or a marketplace: it becomes a sales order, not a lead (see online.ts).
    if (e.eventType === 'cancelled') return cancelOnlineOrder(ctx, e.channel, e.externalId, String(p.name ?? e.externalId));
    return takeOrder(ctx, e.channel === 'shopify' ? fromShopify(p) : (p as OnlineOrder));
  }
  if (e.channel === 'google') {
    const incoming = fromGoogleColumns(p.lead?.user_column_data ?? []);
    const [c] = await ctx.tx.select().from(campaigns).where(eq(campaigns.id, p.campaign_id));
    if (!c) throw new Unusable('The campaign link this lead form was set up with no longer exists');
    const lead = await capture(ctx, incoming, { sourceId: c.sourceId, sourceDetail: c.name, campaignId: c.id, externalRef: `google:${e.externalId}`, fallbackName: 'Google Ads enquiry' });
    return { leadId: lead.id, summary: `${lead.name}, ${lead.phone} · ${c.name}` };
  }
  if (e.channel === 'meta') {
    const incoming = fromMetaFields(fetched!.field_data);
    const detail = fetched!.campaign_name ?? fetched!.ad_name ?? fetched!.form_name ?? (fetched!.form_id ? `Lead form ${fetched!.form_id}` : null);
    // A lead brought in later than it was filled in says when, so nobody takes a month-old enquiry for today's.
    const filled = fetched!.created_time ? new Date(fetched!.created_time) : null;
    const old = filled && !Number.isNaN(filled.getTime()) && Date.now() - filled.getTime() > 86_400_000;
    const lead = await capture(ctx, incoming, {
      sourceId: await sourceIdByName(ctx.tx, 'Meta Ads'), sourceDetail: detail, externalRef: `meta:${e.externalId}`,
      fallbackName: fetched!.platform === 'ig' ? 'Instagram enquiry' : 'Facebook enquiry',
      notes: old ? `Filled in on ${formatDate(istDate(filled!))}` : null,
    });
    return { leadId: lead.id, summary: `${lead.name}, ${lead.phone}${detail ? ` · ${detail}` : ''}` };
  }
  if (e.channel === 'whatsapp') {
    const m = p.message;
    const phone = normalisePhone(`+${String(m.from ?? '')}`);
    if (!phone) throw new Unusable(`+${m.from} is not an Indian mobile number`);
    const text = whatsappText(m);
    // One at a time per phone, the same lock captureLead takes, so two quick messages cannot both start a lead.
    await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${phone}, 0))`);
    const [open] = await ctx.tx.select().from(leads)
      .where(and(eq(leads.phone, phone), inArray(leads.stage, OPEN_LEAD_STAGES))).orderBy(asc(leads.createdAt)).limit(1);
    if (open) {
      // Already being followed up: the message goes on that lead's timeline, where its owner sees it.
      await ctx.tx.insert(leadActivities).values({ leadId: open.id, type: 'whatsapp', note: `They wrote: ${text}`.slice(0, 2000), userId: null });
      // They have answered: the plan of messages stops, and the lead is due now for a person to reply.
      const onPlan = Boolean(open.planId);
      await stopPlan(ctx, open.id, 'they replied on WhatsApp');
      await ctx.tx.update(leads).set({ updatedAt: new Date(), ...(onPlan ? { nextFollowUpAt: new Date() } : {}) }).where(eq(leads.id, open.id));
      return { leadId: open.id, summary: `${open.name}, ${phone} · message on ${open.leadNo}` };
    }
    // From a Click-to-WhatsApp ad the first message says which ad it was.
    const ad = m.referral?.source_type === 'ad' ? (clean(m.referral.headline) ?? 'Click to WhatsApp ad') : null;
    const lead = await capture(ctx, { name: clean(p.contact_name), phone, email: null, extras: [] }, {
      sourceId: await sourceIdByName(ctx.tx, ad ? 'Meta Ads' : 'WhatsApp'), sourceDetail: ad, externalRef: `wa:${e.externalId}`,
      fallbackName: 'WhatsApp enquiry', notes: text ? `WhatsApp: ${text}` : null,
    });
    return { leadId: lead.id, summary: `${lead.name}, ${phone}${ad ? ` · ${ad}` : ''}` };
  }
  throw new Unusable(`Nothing knows how to read a "${e.channel}" event`);
}

export async function processEvent(db: DB, deps: CrmDeps, id: string): Promise<'processed' | 'failed' | 'skipped'> {
  try {
    const [seen] = await db.select().from(channelEvents).where(eq(channelEvents.id, id));
    if (!seen || (seen.status !== 'received' && seen.status !== 'failed')) return 'skipped';
    // The call to Meta happens before the transaction, so no database lock is held while waiting on the network.
    // A lead brought in from Meta's lead forms already carries its answers; one announced by webhook has to be read.
    const carried = seen.channel === 'meta' && Array.isArray((seen.payload as any)?.field_data) ? (seen.payload as MetaLead) : null;
    const fetched = seen.channel === 'meta' ? (carried ?? await fetchMetaLead(deps, seen.externalId)) : null;
    return await db.transaction(async (trx) => {
      const tx = trx as unknown as DB;
      const [e] = await tx.select().from(channelEvents).where(eq(channelEvents.id, id)).for('update');
      if (!e || (e.status !== 'received' && e.status !== 'failed')) return 'skipped' as const;
      const result = await handle({ tx, user: null }, e, fetched);
      await tx.update(channelEvents)
        .set({ status: 'processed', leadId: result.leadId ?? null, orderId: result.orderId ?? null, summary: result.summary, error: null, attempts: e.attempts + 1, processedAt: new Date() })
        .where(eq(channelEvents.id, id));
      return 'processed' as const;
    });
  } catch (err) {
    const expected = err instanceof Unusable || err instanceof NotReady || err instanceof AppError;
    if (!expected) console.error(err);
    await db.update(channelEvents)
      .set({ status: 'failed', error: (expected ? (err as Error).message : 'Something unexpected went wrong; it is in the server log').slice(0, 500), attempts: sql`${channelEvents.attempts} + 1` })
      .where(and(eq(channelEvents.id, id), inArray(channelEvents.status, ['received', 'failed'])));
    return 'failed';
  }
}

/** Try again everything that has not become a lead yet: after setting a token, say, or fixing a campaign. */
export async function processPending(db: DB, deps: CrmDeps, limit = 500, channels?: readonly string[]): Promise<{ processed: number; failed: number }> {
  const pending = await db.select({ id: channelEvents.id }).from(channelEvents)
    .where(and(inArray(channelEvents.status, ['received', 'failed']), channels ? inArray(channelEvents.channel, [...channels]) : undefined))
    .orderBy(asc(channelEvents.createdAt)).limit(limit);
  const out = { processed: 0, failed: 0 };
  for (const p of pending) {
    const r = await processEvent(db, deps, p.id);
    if (r === 'processed') out.processed++;
    else if (r === 'failed') out.failed++;
  }
  return out;
}

/** Store an incoming event once. Returns null when this exact event was already stored (the sender repeating itself). */
export async function record(db: DB, v: typeof channelEvents.$inferInsert): Promise<string | null> {
  const [row] = await db.insert(channelEvents).values(v).onConflictDoNothing().returning({ id: channelEvents.id });
  return row?.id ?? null;
}

export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Meta signs every webhook with the app secret; anything unsigned or signed with another key is not from Meta. */
function signedByMeta(req: Request): boolean {
  const header = String(req.headers['x-hub-signature-256'] ?? '');
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!config.metaAppSecret || !raw || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', config.metaAppSecret).update(raw).digest('hex');
  return safeEqual(header.slice(7), expected);
}

// ---------------------------------------------------------------------------
// Asking Meta: is the connection right, and what leads are already there
// ---------------------------------------------------------------------------
/** Meta said no. The message is Meta's own, which names the token or permission at fault. */
class MetaRefused extends Error {}

/** One call to Meta's Graph API. `path` may be a full address (the "next page" link Meta gives). */
async function graph(deps: CrmDeps, path: string, token: string): Promise<any> {
  const url = path.startsWith('https://') ? path
    : `https://graph.facebook.com/${config.metaGraphVersion}/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
  let res;
  try {
    res = await deps.getJson(url);
  } catch {
    throw new MetaRefused('Meta could not be reached. Try again in a while.');
  }
  if (res.status !== 200 || !res.body) throw new MetaRefused(String(res.body?.error?.message ?? `Meta answered with HTTP ${res.status}`).slice(0, 300));
  return res.body;
}

const said = (e: unknown) => (e instanceof MetaRefused ? e.message : 'Something unexpected went wrong; it is in the server log');

/** What each connection is actually connected to, asked of Meta just now. */
export async function checkConnections(db: DB, deps: CrmDeps) {
  const state = await getSetting(db, 'crm_state');
  const meta = {
    set: { app_secret: Boolean(config.metaAppSecret), verify_token: Boolean(config.metaVerifyToken), page_access_token: Boolean(config.metaPageAccessToken) },
    verified_at: state.meta_verified_at, page: null as { id: string; name: string } | null,
    /** True or false once Meta has said whether the Page sends its lead forms to this app; null when it would not say. */
    leadgen_subscribed: null as boolean | null, problem: null as string | null,
  };
  if (config.metaPageAccessToken) {
    try {
      const page = await graph(deps, 'me?fields=id,name', config.metaPageAccessToken);
      meta.page = { id: String(page.id), name: String(page.name ?? page.id) };
      try {
        const apps = await graph(deps, `${encodeURIComponent(meta.page.id)}/subscribed_apps?fields=subscribed_fields`, config.metaPageAccessToken);
        meta.leadgen_subscribed = (Array.isArray(apps.data) ? apps.data : []).some((a: any) => Array.isArray(a?.subscribed_fields) && a.subscribed_fields.includes('leadgen'));
      } catch (e) {
        if (!(e instanceof MetaRefused)) console.error(e);
      }
    } catch (e) {
      if (!(e instanceof MetaRefused)) console.error(e);
      meta.problem = `The page access token does not work: ${said(e)}`;
    }
  }
  const whatsapp = {
    receiving: Boolean(config.metaAppSecret && config.metaVerifyToken), verified_at: state.whatsapp_verified_at,
    send_set: Boolean(config.whatsappPhoneNumberId && config.whatsappAccessToken),
    number: null as { phone: string; name: string | null; quality: string | null } | null, problem: null as string | null,
  };
  if (whatsapp.send_set) {
    try {
      const n = await graph(deps, `${encodeURIComponent(config.whatsappPhoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`, config.whatsappAccessToken);
      whatsapp.number = { phone: String(n.display_phone_number ?? ''), name: clean(n.verified_name), quality: clean(n.quality_rating) };
    } catch (e) {
      if (!(e instanceof MetaRefused)) console.error(e);
      whatsapp.problem = `The WhatsApp number or its token does not work: ${said(e)}`;
    }
  }
  return { meta, whatsapp };
}

/** How many leads one run takes in, so that it finishes in the time a request is allowed. Pressing again takes the next lot. */
const PULL_PER_RUN = 300;
const PULL_MAX_PAGES = 60;

/** Read the leads of the last `days` days out of every lead form of the Page, and take in the ones not here yet. */
export async function pullMetaLeads(db: DB, deps: CrmDeps, days: number) {
  const token = config.metaPageAccessToken;
  if (!token) throw new AppError(503, 'not_configured', 'The Meta page access token is not set yet (META_PAGE_ACCESS_TOKEN), so the lead forms cannot be read.');
  const since = Math.floor(Date.now() / 1000) - days * 86_400;
  const out = { forms: 0, found: 0, already_here: 0, leads: 0, not_usable: 0, more: false };
  const fresh: string[] = [];
  try {
    const page = await graph(deps, 'me?fields=id,name', token);
    const forms: { id: string; name?: string }[] = [];
    for (let next: string | null = `${encodeURIComponent(String(page.id))}/leadgen_forms?fields=id,name,status&limit=100`, n = 0; next && n < 10; n++) {
      const body: any = await graph(deps, next, token);
      forms.push(...(Array.isArray(body.data) ? body.data : []));
      next = body.paging?.next ?? null;
    }
    out.forms = forms.length;
    const filter = encodeURIComponent(JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: since }]));
    let pages = 0;
    for (const form of forms) {
      const first = `${encodeURIComponent(String(form.id))}/leads?fields=id,created_time,field_data,ad_name,adset_name,campaign_name,form_id,platform&limit=100&filtering=${filter}`;
      for (let next: string | null = first; next && !out.more; ) {
        if (++pages > PULL_MAX_PAGES) { out.more = true; break; }
        const body: any = await graph(deps, next, token);
        for (const lead of Array.isArray(body.data) ? body.data : []) {
          if (!lead?.id || !Array.isArray(lead.field_data)) continue;
          out.found++;
          if (fresh.length >= PULL_PER_RUN) { out.more = true; break; }
          const id = await record(db, { channel: 'meta', eventType: 'leadgen', externalId: String(lead.id), payload: { ...lead, form_name: form.name ?? null, pulled: true } });
          if (id) fresh.push(id);
          else out.already_here++;
        }
        next = body.paging?.next ?? null;
      }
      if (out.more) break;
    }
  } catch (e) {
    if (!(e instanceof MetaRefused)) throw e;
    throw new AppError(502, 'meta_refused', `Meta would not hand over the leads: ${e.message}. The page access token needs leads_retrieval, pages_read_engagement and pages_manage_ads.`);
  }
  for (const id of fresh) {
    const r = await processEvent(db, deps, id);
    if (r === 'processed') out.leads++;
    else if (r === 'failed') out.not_usable++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Incoming webhooks (no login: each one proves itself with a signature or a key)
// ---------------------------------------------------------------------------
export function hooksRouter(db: DB, deps: CrmDeps = defaultDeps) {
  const r = Router();

  /** Answer the sender, and turn the new events into leads (before answering in tests, after it in live use). */
  async function finish(res: Response, ids: string[], body: unknown): Promise<void> {
    const work = async () => {
      for (const id of ids) await processEvent(db, deps, id);
    };
    if (deps.awaitProcessing) {
      await work();
      res.status(200).json(body);
    } else {
      res.status(200).json(body);
      work().catch((e) => console.error(e));
    }
  }

  /** Meta's one-time check when the webhook is subscribed: echo the challenge if the verify token matches. */
  const verify = (which: 'meta' | 'whatsapp') => async (req: Request, res: Response) => {
    const token = String(req.query['hub.verify_token'] ?? '');
    if (req.query['hub.mode'] === 'subscribe' && config.metaVerifyToken && safeEqual(token, config.metaVerifyToken)) {
      // Remembered, so the Lead sources screen can say that Meta has accepted this address.
      const state = await getSetting(db, 'crm_state');
      await setSetting(db, 'crm_state', { ...state, [`${which}_verified_at`]: new Date().toISOString() }, null);
      res.type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
      return;
    }
    throw forbidden('Verify token does not match');
  };

  /** Lead ads (object "page") and WhatsApp messages (object "whatsapp_business_account") arrive in the same envelope. */
  async function fromMeta(req: Request, res: Response) {
    if (!config.metaAppSecret) throw new AppError(503, 'not_configured', 'Meta is not connected yet');
    if (!signedByMeta(req)) throw forbidden('Signature does not match');
    const ids: string[] = [];
    for (const entry of Array.isArray(req.body?.entry) ? req.body.entry : []) {
      for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
        const v = change?.value ?? {};
        if (change?.field === 'leadgen' && v.leadgen_id) {
          const id = await record(db, { channel: 'meta', eventType: 'leadgen', externalId: String(v.leadgen_id), payload: v });
          if (id) ids.push(id);
        }
        if (change?.field === 'messages') {
          // Delivery and read receipts ("statuses") are not enquiries; only messages people send us are kept.
          for (const m of Array.isArray(v.messages) ? v.messages : []) {
            if (!m?.id || !m?.from) continue;
            const contact = (Array.isArray(v.contacts) ? v.contacts : []).find((c: any) => c?.wa_id === m.from);
            const id = await record(db, {
              channel: 'whatsapp', eventType: 'message', externalId: String(m.id),
              payload: { message: m, contact_name: contact?.profile?.name ?? null, to: v.metadata?.display_phone_number ?? null },
            });
            if (id) ids.push(id);
          }
        }
      }
    }
    await finish(res, ids, { received: ids.length });
  }

  r.get('/meta', verify('meta'));
  r.post('/meta', fromMeta);
  r.get('/whatsapp', verify('whatsapp'));
  r.post('/whatsapp', fromMeta);

  /**
   * Google Ads lead form. The "key" typed into Google Ads is the token of one of our campaign
   * links, which both proves the request and says which campaign the lead belongs to.
   * Google wants 200 with {} on success, 4xx for a request it should not repeat.
   */
  r.post('/google-ads', async (req, res) => {
    const b = z.object({
      lead_id: z.string().min(1).max(200), google_key: z.string().min(1).max(200),
      user_column_data: z.array(z.object({ column_id: z.string().optional(), string_value: z.string().optional() }).passthrough()).prefault([]),
      is_test: z.boolean().optional(),
    }).passthrough().parse(req.body);
    const [c] = await db.select().from(campaigns).where(eq(campaigns.token, b.google_key));
    if (!c || !c.active) {
      res.status(403).json({ message: 'Unknown key' });
      return;
    }
    // The key is a secret; it is never stored with the event.
    const { google_key: _key, ...lead } = b;
    if (b.is_test) {
      await record(db, { channel: 'google', eventType: 'test', externalId: `${b.lead_id}:${Date.now()}`, payload: { campaign_id: c.id, lead }, status: 'ignored', summary: `Test lead from Google Ads · ${c.name}` });
      res.status(200).json({});
      return;
    }
    const id = await record(db, { channel: 'google', eventType: 'lead', externalId: b.lead_id, payload: { campaign_id: c.id, lead } });
    await finish(res, id ? [id] : [], {});
  });

  /**
   * Any website or form tool: POST name, phone and optionally email and message to a campaign
   * link's address. Field names are read loosely (phone / mobile / phone_number, and so on).
   */
  const cors = (res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  };
  /**
   * Shopify: every new order (and every cancellation) is sent here, signed with the webhook secret.
   * Subscribe "Order creation" and "Order cancellation" in the Shopify admin; "Order payment" is
   * accepted too and counts as the same order.
   */
  r.post('/shopify', async (req, res) => {
    if (!config.shopifyWebhookSecret) throw new AppError(503, 'not_configured', 'Shopify is not connected yet');
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    const sent = String(req.headers['x-shopify-hmac-sha256'] ?? '');
    const expected = raw ? crypto.createHmac('sha256', config.shopifyWebhookSecret).update(raw).digest('base64') : '';
    if (!raw || !sent || !safeEqual(sent, expected)) throw forbidden('Signature does not match');
    const topic = String(req.headers['x-shopify-topic'] ?? '');
    const eventType = topic === 'orders/cancelled' ? 'cancelled' : ['orders/create', 'orders/paid', 'orders/updated'].includes(topic) ? 'order' : null;
    const ids: string[] = [];
    if (eventType && req.body?.id) {
      const id = await record(db, { channel: 'shopify', eventType, externalId: String(req.body.id), payload: req.body, summary: `Shopify ${String(req.body.name ?? req.body.id)}` });
      if (id) ids.push(id);
    }
    await finish(res, ids, { ok: true });
  });

  r.options('/form/:token', (_req, res) => {
    cors(res);
    res.status(204).end();
  });
  r.post('/form/:token', async (req, res) => {
    cors(res);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pick = (...keys: string[]) => clean(keys.map((k) => body[k]).find((v) => clean(v)));
    const [c] = await db.select().from(campaigns).where(eq(campaigns.token, String(req.params.token)));
    if (!c || !c.active) throw must(null, 'Campaign');
    const phone = normalisePhone(pick('phone', 'mobile', 'phone_number', 'mobile_number', 'contact', 'whatsapp'));
    if (!phone) throw badRequest('A valid 10-digit Indian mobile number is needed');
    const name = pick('name', 'full_name', 'fullname', 'your_name') ?? ([pick('first_name'), pick('last_name')].filter(Boolean).join(' ') || 'Website enquiry');
    await db.transaction(async (tx) => {
      await captureLead({ tx: tx as unknown as DB, user: null }, {
        name: name.slice(0, 150), phone, email: isEmail(pick('email', 'email_address')), sourceId: c.sourceId, sourceDetail: c.name, campaignId: c.id,
        notes: pick('message', 'notes', 'comments', 'enquiry', 'requirement')?.slice(0, 1000) ?? null,
        consentSource: `their own enquiry form (${c.name})`,
      });
    });
    res.status(201).json({ ok: true });
  });

  return r;
}

// ---------------------------------------------------------------------------
// Quick replies
// ---------------------------------------------------------------------------
/** Fill a quick reply with this lead's details. Unknown placeholders are left as typed. */
export function renderTemplate(body: string, v: { name: string; myName: string; company: string; products: string[] }): string {
  const products = v.products.length === 0 ? 'our products'
    : v.products.length === 1 ? v.products[0]! : `${v.products.slice(0, -1).join(', ')} and ${v.products.at(-1)}`;
  const values: Record<string, string> = {
    name: v.name, first_name: v.name.trim().split(/\s+/)[0] ?? v.name, my_name: v.myName, company: v.company, products,
  };
  return body.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

/** Contacting a lead always leaves it with a next follow-up, so it cannot be forgotten afterwards; a New lead becomes Contacted. */
async function markContacted(ctx: Ctx, lead: typeof leads.$inferSelect): Promise<typeof leads.$inferSelect> {
  const days = await getSetting(ctx.tx, 'default_follow_up_days');
  const next = lead.nextFollowUpAt && lead.nextFollowUpAt > new Date() ? lead.nextFollowUpAt : new Date(Date.now() + days * 86400_000);
  if (lead.stage === 'new') await moveLead(ctx, lead.id, { stage: 'contacted', nextFollowUpAt: next });
  else {
    const patch: Partial<typeof leads.$inferInsert> = { updatedAt: new Date() };
    if (!lead.firstContactedAt) patch.firstContactedAt = new Date();
    if (OPEN_LEAD_STAGES.includes(lead.stage)) patch.nextFollowUpAt = next;
    await ctx.tx.update(leads).set(patch).where(eq(leads.id, lead.id));
  }
  // On a follow-up plan, this contact does the step that was due and the next step sets the date.
  await advancePlan(ctx, lead.id);
  const [row] = await ctx.tx.select().from(leads).where(eq(leads.id, lead.id));
  return row!;
}

/** The quick reply written out for this lead by this person. */
async function quickReplyText(ctx: Ctx, lead: typeof leads.$inferSelect, templateId: string): Promise<{ name: string; text: string }> {
  const [t] = await ctx.tx.select().from(messageTemplates).where(eq(messageTemplates.id, templateId));
  if (!t || !t.active) throw badRequest('That quick reply is not available');
  const wanted = lead.interestedItemIds.length ? await ctx.tx.select({ name: items.name }).from(items).where(inArray(items.id, lead.interestedItemIds)) : [];
  const company = await getSetting(ctx.tx, 'company');
  return { name: t.name, text: renderTemplate(t.body, { name: lead.name, myName: ctx.user!.name, company: company.name, products: wanted.map((i) => i.name).sort() }) };
}

export function crmRouter(db: DB, deps: CrmDeps = defaultDeps) {
  const r = Router();

  /**
   * Send a WhatsApp message to the lead from the business number, without leaving the app.
   * WhatsApp allows free text only within 24 hours of the customer's last message; outside that
   * window it refuses, and the answer says so in plain words. The message goes on the lead's
   * timeline only once WhatsApp has accepted it.
   */
  r.post('/leads/:id/whatsapp', requirePerm('leads:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ text: emptyToNull(z.string().trim().max(4000)).optional(), template_id: emptyToNull(zId).optional() }).parse(req.body);
    if (!config.whatsappPhoneNumberId || !config.whatsappAccessToken) {
      throw new AppError(503, 'not_configured', 'Sending from here is not connected yet. Use a button that opens WhatsApp on your own phone or computer.');
    }
    const [lead] = await db.select().from(leads).where(eq(leads.id, id));
    must(lead, 'Lead');
    const text = b.text ?? (b.template_id ? (await quickReplyText({ tx: db, user: req.user! }, lead!, b.template_id)).text : null);
    if (!text) throw badRequest('Write a message first');

    let sent;
    try {
      // The call to WhatsApp happens outside any transaction, so nothing is locked while waiting on the network.
      sent = await (deps.postJson ?? defaultDeps.postJson!)(
        `https://graph.facebook.com/${config.metaGraphVersion}/${encodeURIComponent(config.whatsappPhoneNumberId)}/messages`,
        { messaging_product: 'whatsapp', recipient_type: 'individual', to: lead!.phone.replace(/\D/g, ''), type: 'text', text: { preview_url: true, body: text } },
        { Authorization: `Bearer ${config.whatsappAccessToken}` },
      );
    } catch {
      throw new AppError(502, 'whatsapp_unreachable', 'WhatsApp could not be reached. Nothing was sent; try again in a moment.');
    }
    const messageId = sent.body?.messages?.[0]?.id;
    if (sent.status !== 200 || !messageId) {
      const err = sent.body?.error ?? {};
      // 131047: more than 24 hours since the customer last wrote. 131026: the number is not on WhatsApp.
      if (err.code === 131047 || /24 hours|re-?engage/i.test(String(err.message ?? ''))) {
        throw conflict('WhatsApp did not send it: this person last wrote to us more than 24 hours ago, and after that a business may only send an approved template. Send it from your own WhatsApp instead.');
      }
      if (err.code === 131026) throw conflict('WhatsApp did not send it: this number does not seem to be on WhatsApp.');
      throw new AppError(502, 'whatsapp_refused', `WhatsApp did not send it (${String(err.message ?? `HTTP ${sent.status}`).slice(0, 200)}).`);
    }
    const updated = await inTx(db, req, async (ctx) => {
      const [locked] = await ctx.tx.select().from(leads).where(eq(leads.id, id)).for('update');
      await ctx.tx.insert(leadActivities).values({ leadId: id, type: 'whatsapp', userId: ctx.user!.id, note: `We wrote: ${text}`.slice(0, 2000) });
      return markContacted(ctx, locked!);
    });
    res.status(201).json({ data: { message_id: messageId, text, stage: updated.stage, stage_label: LEAD_STAGE_LABELS[updated.stage], next_follow_up_at: updated.nextFollowUpAt } });
  });

  /** The Lead sources screen: what is connected, what has come in, and what could not be turned into a lead. */
  r.get('/integrations', requirePerm('crm:manage'), async (_req, res) => {
    const byChannel = await rows(db, sql`
      select channel, max(created_at) as last_event_at,
             count(*) filter (where status = 'processed')::int as leads,
             count(*) filter (where status = 'failed')::int as failed,
             count(*) filter (where status = 'received')::int as waiting
        from channel_events where created_at > now() - interval '30 days' and channel not in ('shopify', 'amazon', 'flipkart') group by channel`);
    const events = await rows(db, sql`
      select e.id, e.channel, e.event_type, e.status, e.summary, e.error, e.attempts, e.created_at, e.lead_id, l.lead_no
        from channel_events e left join leads l on l.id = e.lead_id
       where e.channel not in ('shopify', 'amazon', 'flipkart')
       order by (e.status in ('failed','received')) desc, e.created_at desc limit 100`);
    const links = await rows(db, sql`
      select c.id, c.name, c.token, s.name as source_name from campaigns c join lead_sources s on s.id = c.source_id
       where c.active order by c.created_at desc`);
    res.json({
      data: {
        meta: { app_secret: Boolean(config.metaAppSecret), verify_token: Boolean(config.metaVerifyToken), page_access_token: Boolean(config.metaPageAccessToken) },
        whatsapp: { send: Boolean(config.whatsappPhoneNumberId && config.whatsappAccessToken) },
        state: await getSetting(db, 'crm_state'),
        campaign_links: links,
        by_channel: byChannel,
        events,
      },
    });
  });

  /** Ask Meta whether the tokens work and what they are connected to, so a wrong value is found here and not by a lost lead. */
  r.post('/integrations/check', requirePerm('crm:manage'), async (_req, res) => {
    res.json({ data: await checkConnections(db, deps) });
  });

  /**
   * Bring in the leads already sitting in Meta's lead forms: the ones from before the connection was
   * made, or any that were missed while something was down. A lead that is already here is not added again.
   */
  r.post('/integrations/meta/fetch', requirePerm('crm:manage'), async (req, res) => {
    const b = z.object({ days: z.coerce.number().int().min(1).max(90).prefault(30) }).parse(req.body ?? {});
    const result = await pullMetaLeads(db, deps, b.days);
    await inTx(db, req, (ctx) => audit(ctx, 'crm', 'meta', 'fetch_leads', null, { days: b.days, ...result }));
    res.json({ data: result });
  });

  r.post('/integrations/retry', requirePerm('crm:manage'), async (_req, res) => {
    res.json({ data: await processPending(db, deps) });
  });

  /** Dismiss something that will never become a lead (spam, a foreign number), so it stops asking for attention. */
  r.post('/events/:id/ignore', requirePerm('crm:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    await inTx(db, req, async (ctx) => {
      const [e] = await ctx.tx.select().from(channelEvents).where(eq(channelEvents.id, id)).for('update');
      must(e, 'Event');
      if (e!.status === 'processed') throw conflict('This one already became a lead');
      await ctx.tx.update(channelEvents).set({ status: 'ignored' }).where(eq(channelEvents.id, id));
      await audit(ctx, 'channel_event', id, 'ignore', { status: e!.status }, { status: 'ignored' });
    });
    res.json({ ok: true });
  });

  // ---- ad spend ------------------------------------------------------------
  /** Spend entries, newest first, plus the campaign names seen on leads so a new entry can be tied to one. */
  r.get('/spend', requirePerm('crm:manage', 'dashboard:marketing'), async (req, res) => {
    const q = z.object({ from: zDate.optional(), to: zDate.optional() }).parse(req.query);
    const data = await rows(db, sql`
      select a.id, a.source_id, s.name as source, a.detail, a.spend_date, a.amount, a.notes, u.name as entered_by
        from ad_spends a join lead_sources s on s.id = a.source_id left join users u on u.id = a.created_by
       where (${q.from ?? null}::date is null or a.spend_date >= ${q.from ?? null}::date)
         and (${q.to ?? null}::date is null or a.spend_date <= ${q.to ?? null}::date)
       order by a.spend_date desc, a.created_at desc limit 2000`);
    if (wantsFile(req)) return sendList(req, res, data, 'ad-spend');
    const names = await rows(db, sql`
      select distinct l.source_id, l.source_detail as detail from leads l where l.source_detail is not null order by 2`);
    res.json({ data, campaign_names: names });
  });

  r.post('/spend', requirePerm('crm:manage'), async (req, res) => {
    const b = z.object({
      source_id: zId, detail: emptyToNull(z.string().trim().max(200)).optional(), spend_date: zDate, amount: zMoneyPos,
      notes: emptyToNull(z.string().trim().max(500)).optional(),
    }).parse(req.body);
    const row = await inTx(db, req, async (ctx) => {
      const [source] = await ctx.tx.select({ id: leadSources.id }).from(leadSources).where(eq(leadSources.id, b.source_id));
      if (!source) throw badRequest('Unknown lead source');
      const [a] = await ctx.tx.insert(adSpends).values({
        sourceId: b.source_id, detail: b.detail ?? null, spendDate: b.spend_date, amount: b.amount, notes: b.notes ?? null, createdBy: ctx.user!.id,
      }).returning();
      await audit(ctx, 'ad_spend', a!.id, 'create', null, a);
      return a!;
    });
    res.status(201).json({ data: row });
  });

  /** Take a wrong entry off. What it was is kept in the audit trail. */
  r.delete('/spend/:id', requirePerm('crm:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    await inTx(db, req, async (ctx) => {
      const [a] = await ctx.tx.select().from(adSpends).where(eq(adSpends.id, id)).for('update');
      must(a, 'Entry');
      await ctx.tx.delete(adSpends).where(eq(adSpends.id, id));
      await audit(ctx, 'ad_spend', id, 'remove', a, null);
    });
    res.json({ ok: true });
  });

  // ---- quick replies -------------------------------------------------------
  const zTemplate = z.object({
    name: zText(80), body: zText(1000), sort_order: z.coerce.number().int().min(0).max(999).optional(), active: z.boolean().optional(),
  });

  r.get('/templates', requirePerm('leads:read'), async (_req, res) => {
    res.json({ data: await db.select().from(messageTemplates).orderBy(asc(messageTemplates.sortOrder), asc(messageTemplates.name)) });
  });

  r.post('/templates', requirePerm('crm:manage'), async (req, res) => {
    const b = zTemplate.parse(req.body);
    const [row] = await db.insert(messageTemplates)
      .values({ name: b.name, body: b.body, sortOrder: b.sort_order ?? 0, active: b.active ?? true, createdBy: req.user!.id }).returning();
    res.status(201).json({ data: row });
  });

  r.patch('/templates/:id', requirePerm('crm:manage'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = zPatch(zTemplate).parse(req.body);
    const patch: Partial<typeof messageTemplates.$inferInsert> = { updatedAt: new Date() };
    if (b.name !== undefined) patch.name = b.name;
    if (b.body !== undefined) patch.body = b.body;
    if (b.sort_order !== undefined) patch.sortOrder = b.sort_order;
    if (b.active !== undefined) patch.active = b.active;
    const [row] = await db.update(messageTemplates).set(patch).where(eq(messageTemplates.id, id)).returning();
    res.json({ data: must(row, 'Quick reply') });
  });

  /**
   * One tap to contact a lead: returns the message with the lead's details filled in and the
   * WhatsApp link to send it, logs the contact on the lead's timeline, and makes sure the lead
   * has a next follow-up. A New lead becomes Contacted.
   */
  r.post('/leads/:id/contact', requirePerm('leads:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    const b = z.object({ channel: z.enum(['whatsapp', 'call']).prefault('whatsapp'), template_id: emptyToNull(zId).optional() }).parse(req.body);
    const result = await inTx(db, req, async (ctx) => {
      const [lead] = await ctx.tx.select().from(leads).where(eq(leads.id, id)).for('update');
      must(lead, 'Lead');
      let text = '';
      let sent: string | null = null;
      if (b.template_id) {
        const reply = await quickReplyText(ctx, lead!, b.template_id);
        text = reply.text;
        sent = reply.name;
      }
      await ctx.tx.insert(leadActivities).values({
        leadId: id, type: b.channel, userId: ctx.user!.id,
        note: b.channel === 'call' ? 'Called' : sent ? `Sent "${sent}": ${text}`.slice(0, 2000) : 'Opened the WhatsApp chat',
      });
      return { lead: await markContacted(ctx, lead!), text };
    });
    const digits = result.lead.phone.replace(/\D/g, '');
    res.json({
      data: {
        text: result.text,
        whatsapp_url: `https://wa.me/${digits}${result.text ? `?text=${encodeURIComponent(result.text)}` : ''}`,
        stage: result.lead.stage, stage_label: LEAD_STAGE_LABELS[result.lead.stage], next_follow_up_at: result.lead.nextFollowUpAt,
      },
    });
  });

  return r;
}
