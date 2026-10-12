import { eq, sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { audit } from '../core/audit';
import { requirePerm } from '../core/auth';
import { rows, type DB } from '../db/client';
import { channelEvents } from '../db/schema';
import { badRequest, conflict, must } from '../lib/errors';
import { inTx, zId } from '../lib/http';
import { defaultDeps, processEvent, processPending, record, type CrmDeps } from './crm';
import { CHANNEL_NAMES, ONLINE_CHANNELS, OrderFileError, onlineSummary, parseOrderFile } from './online';

/** The Online orders screen: what is connected, what has come in, and what could not be taken in and why. */
export function onlineRouter(db: DB, deps: CrmDeps = defaultDeps) {
  const r = Router();

  r.get('/', requirePerm('sales:read'), async (_req, res) => {
    const events = await rows(db, sql`
      select e.id, e.channel, e.event_type, e.status, e.summary, e.error, e.attempts, e.created_at, e.order_id, o.order_no, o.status as order_status
        from channel_events e left join sales_orders o on o.id = e.order_id
       where e.channel in ('shopify', 'amazon', 'flipkart')
       order by (e.status in ('failed', 'received')) desc, e.created_at desc limit 200`);
    res.json({ data: { shopify: { connected: Boolean(config.shopifyWebhookSecret) }, by_channel: await onlineSummary(db), events } });
  });

  /** An order report downloaded from Amazon or Flipkart: each order in it is taken in once, however often the file is sent. */
  r.post('/import', requirePerm('sales:write'), async (req, res) => {
    const b = z.object({ channel: z.enum(['amazon', 'flipkart']), file: z.string().min(1, 'the file is empty') }).parse(req.body);
    let parsed;
    try {
      parsed = parseOrderFile(b.channel, b.file);
    } catch (e) {
      if (e instanceof OrderFileError) throw badRequest(e.message);
      throw e;
    }
    if (parsed.orders.length === 0) throw badRequest(`No orders were found in the file${parsed.skipped ? ` (${parsed.skipped} cancelled or returned rows were left out)` : ''}.`);
    const out = { orders: parsed.orders.length, taken_in: 0, could_not: 0, already_here: 0, left_out: parsed.skipped };
    for (const o of parsed.orders) {
      const id = await record(db, { channel: b.channel, eventType: 'order', externalId: o.externalId, payload: o, summary: `${CHANNEL_NAMES[b.channel]} ${o.name}` });
      if (!id) {
        out.already_here++;
        continue;
      }
      const result = await processEvent(db, deps, id);
      if (result === 'processed') out.taken_in++;
      else out.could_not++;
    }
    res.status(201).json({ data: out });
  });

  /** Try again everything that could not be taken in: after adding the missing item, say. */
  r.post('/retry', requirePerm('sales:write'), async (_req, res) => {
    res.json({ data: await processPending(db, deps, 500, ONLINE_CHANNELS) });
  });

  /** Set aside one that will never be taken in (a test order, something handled by hand). */
  r.post('/events/:id/ignore', requirePerm('sales:write'), async (req, res) => {
    const id = zId.parse(req.params.id);
    await inTx(db, req, async (ctx) => {
      const [e] = await ctx.tx.select().from(channelEvents).where(eq(channelEvents.id, id)).for('update');
      must(e, 'Order');
      if (!(ONLINE_CHANNELS as readonly string[]).includes(e!.channel)) throw badRequest('That is not an online order');
      if (e!.status === 'processed') throw conflict('This one was already taken in');
      await ctx.tx.update(channelEvents).set({ status: 'ignored' }).where(eq(channelEvents.id, id));
      await audit(ctx, 'channel_event', id, 'ignore', { status: e!.status }, { status: 'ignored' });
    });
    res.json({ ok: true });
  });

  return r;
}
