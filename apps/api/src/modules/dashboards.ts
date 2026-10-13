import { sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { D, addDays, can, fyOf, fyRange, istDate, money } from '@radcore/shared';
import { requireAuth, requirePerm } from '../core/auth';
import { rows, type DB } from '../db/client';
import { zDate } from '../lib/http';
import { gstSummary } from './gst';
import { LATE, ensureTasks } from './ops';

/** Default range: month to date (IST). Every figure is computed live from the records (PRD 7.10). */
function range(query: unknown) {
  const today = istDate();
  const q = z.object({ from: zDate.optional(), to: zDate.optional() }).parse(query);
  return { from: q.from ?? `${today.slice(0, 7)}-01`, to: q.to ?? today, today };
}

const IST = sql.raw(`'Asia/Kolkata'`);

/** Net sales in a date range by channel: issued invoices less credit notes. */
function salesByChannel(db: DB, from: string, to: string) {
  return rows(db, sql`
    select i.channel,
           count(*) filter (where i.doc_type = 'tax_invoice')::int as invoices,
           sum(case when i.doc_type = 'credit_note' then -i.grand_total else i.grand_total end) as value,
           sum(case when i.doc_type = 'credit_note' then -i.taxable_total else i.taxable_total end) as taxable
      from invoices i
     where i.status = 'issued' and i.invoice_date between ${from}::date and ${to}::date
     group by i.channel order by 3 desc`);
}

export function dashboardsRouter(db: DB) {
  const r = Router();

  /**
   * The picture on the home screen: how many things are sitting at each step of
   * lead-to-cash and purchase-to-stock right now. Each person gets only the steps their
   * role may see, and rupee amounts only with accounts access.
   */
  r.get('/overview', requireAuth, async (req, res) => {
    const role = req.user!.role;
    const today = istDate();
    const money = can(role, 'accounts:read');
    const one = async <T>(q: ReturnType<typeof sql>) => (await rows<T>(db, q))[0]!;
    const data: Record<string, unknown> = {};

    if (can(role, 'leads:read')) {
      data.leads = await one(sql`
        select count(*) filter (where stage = 'new')::int as fresh,
               count(*) filter (where stage in ('contacted','interested','meeting_booked'))::int as in_progress,
               count(*) filter (where stage in ('new','contacted','interested','meeting_booked')
                                  and (next_follow_up_at at time zone ${IST})::date <= ${today}::date)::int as follow_ups_due,
               count(*) filter (where stage = 'converted'
                                  and (converted_at at time zone ${IST})::date >= date_trunc('month', ${today}::date))::int as converted_this_month
          from leads`);
    }
    if (can(role, 'sales:read')) {
      data.orders = await one(sql`
        select count(*) filter (where o.status = 'draft')::int as quotes,
               count(*) filter (where o.status = 'confirmed' and exists (
                 select 1 from sales_order_lines l where l.order_id = o.id and l.delivered_qty < l.qty))::int as to_deliver,
               count(*) filter (where o.status in ('confirmed','delivered') and exists (
                 select 1 from sales_order_lines l where l.order_id = o.id and l.invoiced_qty < l.delivered_qty))::int as to_invoice
          from sales_orders o`);
    }
    if (can(role, 'invoices:read')) {
      const inv = await one<{ unpaid: number; outstanding: string }>(sql`
        select count(*)::int as unpaid, coalesce(sum(outstanding), 0)::numeric(14,2)::text as outstanding
          from v_invoice_outstanding where outstanding > 0`);
      data.invoices = money ? inv : { unpaid: inv.unpaid };
    }
    if (can(role, 'purchasing:read')) {
      const bills = await one<{ unpaid: number; outstanding: string }>(sql`
        select count(*)::int as unpaid, coalesce(sum(outstanding), 0)::numeric(14,2)::text as outstanding
          from v_bill_outstanding where outstanding > 0`);
      data.purchasing = {
        ...(await one<Record<string, number>>(sql`
          select (select count(*) from purchase_orders where status in ('sent','partly_received'))::int as awaiting_goods,
                 (select count(*) from goods_receipts where status = 'received')::int as waiting_qc,
                 (select count(distinct grn_id) from goods_receipt_lines where coalesce(rejected_qty, 0) > returned_qty)::int as rejects_to_return`)),
        bills_unpaid: bills.unpaid,
        ...(money ? { bills_outstanding: bills.outstanding } : {}),
      };
    }
    if (can(role, 'stock:read')) {
      data.stock = await one(sql`
        select (select count(*) from items i
                  left join (select m.item_id, sum(m.qty) as qty from stock_movements m join locations l on l.id = m.location_id
                              where l.type in ('stores', 'showroom') group by m.item_id) s on s.item_id = i.id
                 where i.is_stock_item and i.active and i.reorder_level is not null and coalesce(s.qty, 0) < i.reorder_level)::int as low_stock,
               (select count(*) from stock_adjustments where status = 'pending')::int as adjustments_pending`);
    }
    if (money) {
      data.bank = await one(sql`select count(*)::int as unreconciled from bank_statement_lines where status = 'unmatched'`);
    }
    if (can(role, 'hr:read')) {
      data.hiring = await one(sql`
        select count(*) filter (where stage = 'applied')::int as applied,
               count(*) filter (where stage = 'shortlisted')::int as shortlisted,
               count(*) filter (where stage = 'interview')::int as interview,
               count(*) filter (where stage = 'offered')::int as offered,
               count(*) filter (where stage = 'hired' and (closed_at at time zone ${IST})::date >= date_trunc('month', ${today}::date))::int as hired_this_month,
               (select count(*) from job_openings where status = 'open')::int as open_positions
          from applicants`);
    }
    // Recurring tasks are created on first look each day, so the counts below are for today.
    await ensureTasks(db, today);
    if (can(role, 'ops:read')) {
      data.ops = await one(sql`
        select (select count(*) from tasks t where t.status = 'open' and t.due_date = ${today}::date and not ${LATE})::int as tasks_open_today,
               (select count(*) from tasks t where ${LATE})::int as tasks_overdue,
               (select count(*) from maintenance_schedules
                 where active and next_due_on <= ${today}::date + remind_days_before)::int as maintenance_due`);
    }
    if (can(role, 'leads:write')) {
      data.my_leads = await one(sql`
        select count(*) filter (where stage = 'new')::int as fresh,
               count(*) filter (where stage in ('contacted','interested','meeting_booked')
                                  and (next_follow_up_at at time zone ${IST})::date <= ${today}::date)::int as follow_ups_due
          from leads where owner_id = ${req.user!.id}`);
    }
    // For everyone, whatever their role: what is sitting with me.
    data.mine = await one(sql`
      select (select count(*) from tasks t where t.assignee_id = ${req.user!.id} and t.status = 'open' and t.due_date = ${today}::date and not ${LATE})::int as tasks_today,
             (select count(*) from tasks t where t.assignee_id = ${req.user!.id} and ${LATE})::int as tasks_overdue,
             (select count(*) from maintenance_schedules
               where assignee_id = ${req.user!.id} and active and next_due_on <= ${today}::date + remind_days_before)::int as maintenance_due,
             (select count(*) from interviews where interviewer_id = ${req.user!.id} and status = 'scheduled')::int as interviews`);
    res.json({ data });
  });

  r.get('/sales', requirePerm('dashboard:sales'), async (req, res) => {
    const { from, to, today } = range(req.query);
    // Week starts Monday.
    const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    const weekStart = addDays(today, -dow);
    const monthStart = `${today.slice(0, 7)}-01`;

    res.json({
      data: {
        range: { from, to },
        sales_today: await salesByChannel(db, today, today),
        sales_this_week: await salesByChannel(db, weekStart, today),
        sales_month_to_date: await salesByChannel(db, monthStart, today),
        sales_in_range: await salesByChannel(db, from, to),
        // Net sales per day for the trend chart (days with no sales are simply absent).
        sales_by_day: await rows(db, sql`
          select i.invoice_date as day,
                 count(*) filter (where i.doc_type = 'tax_invoice')::int as invoices,
                 sum(case when i.doc_type = 'credit_note' then -i.grand_total else i.grand_total end) as value
            from invoices i
           where i.status = 'issued' and i.invoice_date between ${from}::date and ${to}::date
           group by i.invoice_date order by i.invoice_date`),
        pipeline: await rows(db, sql`
          select l.stage, count(*)::int as count,
                 coalesce(sum((select sum(i.retail_price) from items i where i.id = any(l.interested_item_ids))), 0) as value
            from leads l where l.stage in ('new','contacted','interested','meeting_booked') group by l.stage`),
        conversion: await rows(db, sql`
          select u.id as owner_id, coalesce(u.name, 'Unassigned') as owner, count(*)::int as leads,
                 count(*) filter (where l.stage = 'converted')::int as converted,
                 count(*) filter (where l.stage = 'lost')::int as lost,
                 round(100.0 * count(*) filter (where l.stage = 'converted') / nullif(count(*), 0), 1) as conversion_pct
            from leads l left join users u on u.id = l.owner_id
           where (l.created_at at time zone ${IST})::date between ${from}::date and ${to}::date
           group by u.id, u.name order by count(*) desc`),
        follow_ups: await rows(db, sql`
          select u.id as owner_id, coalesce(u.name, 'Unassigned') as owner,
                 count(*) filter (where (l.next_follow_up_at at time zone ${IST})::date = ${today}::date)::int as due_today,
                 count(*) filter (where l.next_follow_up_at < now())::int as overdue
            from leads l left join users u on u.id = l.owner_id
           where l.stage in ('new','contacted','interested','meeting_booked') and l.next_follow_up_at is not null
           group by u.id, u.name
          having count(*) filter (where (l.next_follow_up_at at time zone ${IST})::date <= ${today}::date) > 0
           order by 4 desc`),
        walk_ins_today: (await rows(db, sql`
          select count(*)::int as total,
                 count(*) filter (where l.stage = 'converted')::int as purchases,
                 count(*) filter (where l.stage <> 'converted')::int as enquiries
            from leads l join lead_sources s on s.id = l.source_id
           where s.name = 'Walk-in' and (l.created_at at time zone ${IST})::date = ${today}::date`))[0],
        top_items: await rows(db, sql`
          select il.item_id, il.description as item,
                 sum(case when i.doc_type = 'credit_note' then -il.qty else il.qty end) as qty,
                 sum(case when i.doc_type = 'credit_note' then -il.taxable_value else il.taxable_value end) as revenue
            from invoice_lines il join invoices i on i.id = il.invoice_id
           where i.status = 'issued' and i.invoice_date between ${from}::date and ${to}::date
           group by il.item_id, il.description order by 4 desc limit 10`),
        top_dealers: await rows(db, sql`
          select p.id as party_id, p.name,
                 sum(case when i.doc_type = 'credit_note' then -i.grand_total else i.grand_total end) as revenue
            from invoices i join parties p on p.id = i.party_id
           where i.status = 'issued' and p.party_type = 'dealer' and i.invoice_date between ${from}::date and ${to}::date
           group by p.id, p.name order by 3 desc limit 10`),
        dealer_outstanding: await rows(db, sql`
          select p.id as party_id, p.name, p.credit_limit, coalesce(b.balance, 0) as outstanding,
                 case when p.credit_limit > 0 then round(100.0 * coalesce(b.balance, 0) / p.credit_limit, 1) end as used_pct
            from parties p left join v_party_balances b on b.party_id = p.id
           where p.party_type = 'dealer' and p.active and (coalesce(b.balance, 0) <> 0 or p.credit_limit is not null)
           order by coalesce(b.balance, 0) desc limit 50`),
      },
    });
  });

  r.get('/marketing', requirePerm('dashboard:marketing'), async (req, res) => {
    const { from, to } = range(req.query);
    const data: Record<string, any> = {
        range: { from, to },
        leads_by_day: await rows(db, sql`
          select (l.created_at at time zone ${IST})::date as day, s.name as source, count(*)::int as leads
            from leads l join lead_sources s on s.id = l.source_id
           where (l.created_at at time zone ${IST})::date between ${from}::date and ${to}::date
           group by 1, 2 order by 1, 2`),
        leads_by_campaign: await rows(db, sql`
          select s.name as source, coalesce(l.source_detail, '-') as campaign, count(*)::int as leads,
                 count(*) filter (where l.stage = 'converted')::int as converted
            from leads l join lead_sources s on s.id = l.source_id
           where (l.created_at at time zone ${IST})::date between ${from}::date and ${to}::date
           group by 1, 2 order by 3 desc`),
        // Conversion and revenue by source, attributed through sales_orders.lead_id.
        by_source: await rows(db, sql`
          select s.id as source_id, s.name as source, count(l.id)::int as leads,
                 count(l.id) filter (where l.stage = 'converted')::int as converted,
                 count(l.id) filter (where l.stage = 'lost')::int as lost,
                 round(100.0 * count(l.id) filter (where l.stage = 'converted') / nullif(count(l.id), 0), 1) as conversion_pct,
                 coalesce(sum(rev.revenue), 0) as revenue
            from lead_sources s
            left join leads l on l.source_id = s.id and (l.created_at at time zone ${IST})::date between ${from}::date and ${to}::date
            left join lateral (
              select sum(case when i.doc_type = 'credit_note' then -i.grand_total else i.grand_total end) as revenue
                from sales_orders o join invoices i on i.order_id = o.id and i.status = 'issued'
               where o.lead_id = l.id
            ) rev on true
           where s.active
           group by s.id, s.name order by count(l.id) desc, s.name`),
        // Response time: lead captured -> first contact.
        response_time: (await rows(db, sql`
          select count(*) filter (where l.first_contacted_at is not null)::int as contacted,
                 count(*) filter (where l.first_contacted_at is null and l.stage in ('new'))::int as not_yet_contacted,
                 round(avg(extract(epoch from (l.first_contacted_at - l.created_at)) / 3600.0)::numeric, 1) as avg_hours,
                 round((percentile_cont(0.5) within group (order by extract(epoch from (l.first_contacted_at - l.created_at)) / 3600.0))::numeric, 1) as median_hours
            from leads l
           where (l.created_at at time zone ${IST})::date between ${from}::date and ${to}::date`))[0],
        lost_reasons: await rows(db, sql`
          select lr.name as reason, count(*)::int as leads
            from leads l join lost_reasons lr on lr.id = l.lost_reason_id
           where l.stage = 'lost' and (l.created_at at time zone ${IST})::date between ${from}::date and ${to}::date
           group by lr.name order by 2 desc`),
        walk_in_footfall: await rows(db, sql`
          select (l.created_at at time zone ${IST})::date as day, extract(hour from l.created_at at time zone ${IST})::int as hour,
                 count(*)::int as walk_ins, count(*) filter (where l.stage = 'converted')::int as purchases
            from leads l join lead_sources s on s.id = l.source_id
           where s.name = 'Walk-in' and (l.created_at at time zone ${IST})::date between ${from}::date and ${to}::date
           group by 1, 2 order by 1, 2`),
    };

    // Ad spend in the same period turns the lead counts into cost per lead and per conversion.
    const each = (spend: string, n: number) => (n > 0 ? money(D(spend).div(n)) : null);
    const bySource = await rows<{ source_id: string; spend: string }>(db, sql`
      select source_id, sum(amount)::numeric(14,2)::text as spend from ad_spends
       where spend_date between ${from}::date and ${to}::date group by source_id`);
    data.by_source = data.by_source.map((s: { source_id: string; leads: number; converted: number }) => {
      const spend = bySource.find((x) => x.source_id === s.source_id)?.spend ?? '0.00';
      return { ...s, spend, cost_per_lead: D(spend).gt(0) ? each(spend, s.leads) : null, cost_per_conversion: D(spend).gt(0) ? each(spend, s.converted) : null };
    });
    const byCampaign = await rows<{ source: string; campaign: string; spend: string }>(db, sql`
      select s.name as source, a.detail as campaign, sum(a.amount)::numeric(14,2)::text as spend
        from ad_spends a join lead_sources s on s.id = a.source_id
       where a.detail is not null and a.spend_date between ${from}::date and ${to}::date group by 1, 2`);
    const campaigns: { source: string; campaign: string; leads: number; converted: number }[] = data.leads_by_campaign;
    // Money spent on a named campaign that brought no leads still belongs on the list. Spend entered for a source
    // as a whole is not a campaign; it shows against the source.
    for (const c of byCampaign) {
      if (!campaigns.some((r) => r.source === c.source && r.campaign === c.campaign)) campaigns.push({ source: c.source, campaign: c.campaign, leads: 0, converted: 0 });
    }
    data.leads_by_campaign = campaigns.map((r) => {
      const spend = byCampaign.find((c) => c.source === r.source && c.campaign === r.campaign)?.spend ?? '0.00';
      return { ...r, spend, cost_per_lead: D(spend).gt(0) ? each(spend, r.leads) : null, cost_per_conversion: D(spend).gt(0) ? each(spend, r.converted) : null };
    });
    const totalSpend = bySource.reduce((sum, x) => sum.plus(x.spend), D(0));
    const paidLeads = data.by_source.filter((s: { spend: string }) => D(s.spend).gt(0)).reduce((n: number, s: { leads: number }) => n + s.leads, 0);
    data.spend = { total: money(totalSpend), leads_from_paid_sources: paidLeads, cost_per_lead: totalSpend.gt(0) ? each(money(totalSpend), paidLeads) : null };
    // The team, person by person: what came to them in the period, how fast they answered, what they closed, and what is waiting now.
    data.team = await rows(db, sql`
      select u.id, u.name,
             count(l.id) filter (where (l.created_at at time zone ${IST})::date between ${from}::date and ${to}::date)::int as received,
             count(l.id) filter (where (l.created_at at time zone ${IST})::date between ${from}::date and ${to}::date and l.first_contacted_at is not null)::int as contacted,
             round(avg(extract(epoch from (l.first_contacted_at - l.created_at)) / 60)
               filter (where (l.created_at at time zone ${IST})::date between ${from}::date and ${to}::date and l.first_contacted_at is not null))::int as avg_response_min,
             count(l.id) filter (where (l.converted_at at time zone ${IST})::date between ${from}::date and ${to}::date)::int as converted,
             count(l.id) filter (where l.stage in ('new', 'contacted', 'interested', 'meeting_booked'))::int as open_now,
             count(l.id) filter (where l.stage in ('new', 'contacted', 'interested', 'meeting_booked') and l.next_follow_up_at < now())::int as overdue
        from users u join leads l on l.owner_id = u.id
       group by u.id, u.name
      having count(l.id) filter (where (l.created_at at time zone ${IST})::date between ${from}::date and ${to}::date) > 0
          or count(l.id) filter (where l.stage in ('new', 'contacted', 'interested', 'meeting_booked')) > 0
       order by 3 desc, u.name`);
    res.json({ data });
  });

  /** Stores: what the stock is worth and where, what is running low, what is stuck, and what has stopped moving. */
  r.get('/stores', requirePerm('dashboard:stores'), async (req, res) => {
    const { from, to, today } = range(req.query);
    res.json({
      data: {
        range: { from, to },
        value_by_location: await rows(db, sql`
          select l.id, l.name, l.type, coalesce(sum(m.value), 0)::numeric(16,2) as value, count(distinct m.item_id) filter (where m.qty <> 0)::int as items
            from locations l left join stock_movements m on m.location_id = l.id
           where l.active group by l.id order by l.name`),
        value_by_type: await rows(db, sql`
          select i.item_type, coalesce(sum(m.value), 0)::numeric(16,2) as value
            from stock_movements m join items i on i.id = m.item_id group by i.item_type order by 2 desc`),
        // Below the reorder level, counting only stock that can be sold or used (not the rejected bin).
        low_stock: await rows(db, sql`
          select i.id, i.sku, i.name, i.unit, i.reorder_level, coalesce(s.qty, 0) as qty
            from items i
            left join (select m.item_id, sum(m.qty) as qty from stock_movements m join locations l on l.id = m.location_id
                        where l.type in ('stores', 'showroom') group by m.item_id) s on s.item_id = i.id
           where i.is_stock_item and i.active and i.reorder_level is not null and coalesce(s.qty, 0) < i.reorder_level
           order by coalesce(s.qty, 0) / nullif(i.reorder_level, 0), i.name limit 50`),
        awaiting_goods: await rows(db, sql`
          select o.id, o.po_no, p.name as supplier, o.order_date, o.expected_date, o.status,
                 (${today}::date - coalesce(o.expected_date, o.order_date))::int as days_waiting,
                 (o.expected_date is not null and o.expected_date < ${today}::date) as late
            from purchase_orders o join parties p on p.id = o.supplier_id
           where o.status in ('sent','partly_received') order by coalesce(o.expected_date, o.order_date) limit 50`),
        waiting_qc: await rows(db, sql`
          select g.id, g.grn_no, p.name as supplier, g.received_at,
                 (${today}::date - (g.received_at at time zone ${IST})::date)::int as days_waiting
            from goods_receipts g join parties p on p.id = g.supplier_id
           where g.status = 'received' order by g.received_at limit 50`),
        rejects_to_return: (await rows(db, sql`
          select count(distinct grn_id)::int as receipts, coalesce(sum(coalesce(rejected_qty, 0) - returned_qty), 0) as qty
            from goods_receipt_lines where coalesce(rejected_qty, 0) > returned_qty`))[0],
        adjustments_pending: (await rows(db, sql`select count(*)::int as count from stock_adjustments where status = 'pending'`))[0],
        // Goods in and out by value per day. Transfers only move stock between our own locations, so they are left out.
        movements_by_day: await rows(db, sql`
          select (m.posted_at at time zone ${IST})::date as day,
                 coalesce(sum(m.value) filter (where m.qty > 0), 0)::numeric(16,2) as value_in,
                 coalesce(-sum(m.value) filter (where m.qty < 0), 0)::numeric(16,2) as value_out
            from stock_movements m
           where m.movement_type <> 'transfer' and (m.posted_at at time zone ${IST})::date between ${from}::date and ${to}::date
           group by 1 order by 1`),
        fast_movers: await rows(db, sql`
          select i.id, i.sku, i.name, -sum(m.qty) as qty_out
            from stock_movements m join items i on i.id = m.item_id
           where m.movement_type = 'sale_out' and (m.posted_at at time zone ${IST})::date between ${from}::date and ${to}::date
           group by i.id having -sum(m.qty) > 0 order by 4 desc limit 10`),
        // Money sitting on the shelf: in stock, and nothing sold or used for 90 days.
        not_moving: await rows(db, sql`
          select i.id, i.sku, i.name, v.qty, v.value,
                 (select max((m.posted_at at time zone ${IST})::date) from stock_movements m where m.item_id = i.id and m.qty < 0 and m.movement_type <> 'transfer') as last_out
            from items i join v_item_valuation v on v.item_id = i.id
           where v.qty > 0 and not exists (
                   select 1 from stock_movements m where m.item_id = i.id and m.qty < 0 and m.movement_type <> 'transfer'
                      and m.posted_at > now() - interval '90 days')
             and exists (select 1 from stock_movements m where m.item_id = i.id and m.posted_at <= now() - interval '90 days')
           order by v.value desc limit 20`),
      },
    });
  });

  /** The owner's one page: the few numbers that say how the whole business is doing today. */
  r.get('/owner', requirePerm('dashboard:owner'), async (_req, res) => {
    const today = istDate();
    const monthStart = `${today.slice(0, 7)}-01`;
    const lastMonthEnd = addDays(monthStart, -1);
    const lastMonthStart = `${lastMonthEnd.slice(0, 7)}-01`;
    // The same number of days into last month, so the comparison is like for like.
    const lastMonthSameDay = addDays(lastMonthStart, Number(today.slice(8, 10)) - 1) > lastMonthEnd ? lastMonthEnd : addDays(lastMonthStart, Number(today.slice(8, 10)) - 1);
    const one = async <T>(q: ReturnType<typeof sql>) => (await rows<T>(db, q))[0]!;
    const netSales = (from: string, to: string) => one<{ value: string; invoices: number }>(sql`
      select coalesce(sum(case when doc_type = 'credit_note' then -grand_total else grand_total end), 0)::numeric(16,2)::text as value,
             count(*) filter (where doc_type = 'tax_invoice')::int as invoices
        from invoices where status = 'issued' and invoice_date between ${from}::date and ${to}::date`);
    const profit = (from: string, to: string) => one<{ net_profit: string }>(sql`
      select coalesce(sum(l.credit - l.debit), 0)::numeric(16,2)::text as net_profit
        from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
       where a.type in ('income', 'expense') and e.entry_date between ${from}::date and ${to}::date and e.ref_type <> 'year_close'`);
    await ensureTasks(db, today);
    res.json({
      data: {
        today,
        sales: {
          today: await netSales(today, today),
          month_to_date: await netSales(monthStart, today),
          last_month_same_days: await netSales(lastMonthStart, lastMonthSameDay),
          by_day: await rows(db, sql`
            select invoice_date as day, sum(case when doc_type = 'credit_note' then -grand_total else grand_total end) as value
              from invoices where status = 'issued' and invoice_date between ${addDays(today, -29)}::date and ${today}::date
             group by invoice_date order by invoice_date`),
          by_channel: await salesByChannel(db, monthStart, today),
        },
        money: {
          collected_this_month: (await one<{ v: string }>(sql`
            select coalesce(sum(amount), 0)::numeric(16,2)::text as v from payments
             where status = 'posted' and direction = 'in' and paid_on between ${monthStart}::date and ${today}::date`)).v,
          cash_and_bank: (await one<{ v: string }>(sql`
            select coalesce(sum(l.debit) - sum(l.credit), 0)::numeric(16,2)::text as v
              from journal_lines l join accounts a on a.id = l.account_id where a.subtype is not null`)).v,
          receivables: await one(sql`
            select coalesce(sum(outstanding), 0)::numeric(16,2)::text as total,
                   coalesce(sum(outstanding) filter (where coalesce(due_date, invoice_date) < ${today}::date), 0)::numeric(16,2)::text as overdue
              from v_invoice_outstanding where outstanding > 0`),
          payables: await one(sql`
            select coalesce(sum(outstanding), 0)::numeric(16,2)::text as total,
                   coalesce(sum(outstanding) filter (where due_date < ${today}::date), 0)::numeric(16,2)::text as overdue
              from v_bill_outstanding where outstanding > 0`),
          stock_value: (await one<{ v: string }>(sql`select coalesce(sum(value), 0)::numeric(16,2)::text as v from stock_movements`)).v,
          profit_this_month: (await profit(monthStart, today)).net_profit,
          profit_this_year: (await profit(fyRange(fyOf(today)).from, today)).net_profit,
          gst_this_month: (await gstSummary(db, monthStart, today)).net_payable.total,
        },
        leads: await one(sql`
          select count(*)::int as this_month,
                 count(*) filter (where stage = 'converted')::int as converted,
                 count(*) filter (where stage = 'new')::int as not_contacted,
                 round(100.0 * count(*) filter (where stage = 'converted') / nullif(count(*), 0), 1) as conversion_pct
            from leads where (created_at at time zone ${IST})::date between ${monthStart}::date and ${today}::date`),
        orders: await one(sql`
          select count(*) filter (where o.status = 'draft')::int as quotes,
                 count(*) filter (where o.status = 'confirmed')::int as to_deliver,
                 count(*) filter (where o.status = 'delivered')::int as to_invoice
            from sales_orders o`),
        stores: await one(sql`
          select (select count(*) from items i
                    left join (select m.item_id, sum(m.qty) as qty from stock_movements m join locations l on l.id = m.location_id
                                where l.type in ('stores', 'showroom') group by m.item_id) s on s.item_id = i.id
                   where i.is_stock_item and i.active and i.reorder_level is not null and coalesce(s.qty, 0) < i.reorder_level)::int as low_stock,
                 (select count(*) from goods_receipts where status = 'received')::int as waiting_qc,
                 (select count(*) from purchase_orders where status in ('sent','partly_received'))::int as awaiting_goods`),
        people: await one(sql`
          select (select count(*) from employees where status = 'active')::int as on_rolls,
                 (select count(*) from attendance a where a.date = ${today}::date and a.status in ('present','half_day'))::int as in_today,
                 (select count(*) from job_openings where status = 'open')::int as open_positions,
                 (select count(*) from applicants where stage in ('applied','shortlisted','interview','offered'))::int as applicants_in_progress`),
        operations: await one(sql`
          select (select count(*) from tasks t where ${LATE})::int as late_tasks,
                 (select count(*) from tasks t where t.status = 'open' and t.due_date = ${today}::date and not ${LATE})::int as open_today,
                 (select count(*) from maintenance_schedules where active and next_due_on < ${today}::date)::int as maintenance_overdue,
                 (select count(*) from projects where status in ('planned','active','on_hold'))::int as projects_running,
                 (select count(*) from projects where status in ('planned','active','on_hold') and deadline < ${today}::date)::int as projects_overdue`),
      },
    });
  });

  r.get('/accounts', requirePerm('dashboard:accounts'), async (req, res) => {
    const { from, to, today } = range(req.query);
    const monthStart = `${today.slice(0, 7)}-01`;
    const weekEnd = addDays(today, 7);
    res.json({
      data: {
        range: { from, to },
        invoiced_vs_collected: (await rows(db, sql`
          select (select coalesce(sum(case when doc_type = 'credit_note' then -grand_total else grand_total end), 0)
                    from invoices where status = 'issued' and invoice_date between ${from}::date and ${to}::date) as invoiced,
                 (select coalesce(sum(amount), 0) from payments
                   where status = 'posted' and direction = 'in' and paid_on between ${from}::date and ${to}::date) as collected,
                 (select coalesce(sum(amount), 0) from payments
                   where status = 'posted' and direction = 'out' and paid_on between ${from}::date and ${to}::date) as paid_out`))[0],
        cash_and_bank: await rows(db, sql`
          select a.id, a.code, a.name, a.subtype,
                 coalesce((select sum(l.debit) - sum(l.credit) from journal_lines l where l.account_id = a.id), 0) as balance
            from accounts a where a.subtype is not null and a.active order by a.code`),
        receivables: (await rows(db, sql`
          select coalesce(sum(outstanding), 0) as total,
                 coalesce(sum(outstanding) filter (where (now() at time zone 'Asia/Kolkata')::date - coalesce(due_date, invoice_date) <= 30), 0) as d0_30,
                 coalesce(sum(outstanding) filter (where (now() at time zone 'Asia/Kolkata')::date - coalesce(due_date, invoice_date) between 31 and 60), 0) as d31_60,
                 coalesce(sum(outstanding) filter (where (now() at time zone 'Asia/Kolkata')::date - coalesce(due_date, invoice_date) between 61 and 90), 0) as d61_90,
                 coalesce(sum(outstanding) filter (where (now() at time zone 'Asia/Kolkata')::date - coalesce(due_date, invoice_date) > 90), 0) as d90_plus
            from v_invoice_outstanding where outstanding > 0`))[0],
        top_debtors: await rows(db, sql`
          select o.party_id, coalesce(p.name, 'Cash Sale') as name, sum(o.outstanding) as outstanding, min(o.due_date) as oldest_due
            from v_invoice_outstanding o left join parties p on p.id = o.party_id
           where o.outstanding > 0 group by o.party_id, p.name order by 3 desc limit 10`),
        payables: (await rows(db, sql`
          select coalesce(sum(outstanding), 0) as total,
                 coalesce(sum(outstanding) filter (where due_date < ${today}::date), 0) as overdue,
                 coalesce(sum(outstanding) filter (where due_date between ${today}::date and ${weekEnd}::date), 0) as due_this_week
            from v_bill_outstanding where outstanding > 0`))[0],
        overdue_bills: await rows(db, sql`
          select o.bill_id, o.bill_no, o.supplier_invoice_no, p.name as supplier, o.due_date, o.outstanding, (${today}::date - o.due_date) as days_overdue
            from v_bill_outstanding o join parties p on p.id = o.supplier_id
           where o.outstanding > 0 and o.due_date <= ${weekEnd}::date order by o.due_date limit 20`),
        // Bank statement lines not yet matched to a book entry (PRD 7.10).
        bank_unreconciled: (await rows(db, sql`
          select count(*)::int as lines, coalesce(sum(abs(amount)), 0) as amount
            from bank_statement_lines where status = 'unmatched'`))[0],
        gst_this_month: await gstSummary(db, monthStart, today),
        expenses_by_category: await rows(db, sql`
          select c.name as category, sum(e.amount) as amount, count(*)::int as count
            from expenses e join expense_categories c on c.id = e.category_id
           where e.status = 'posted' and e.expense_date between ${monthStart}::date and ${today}::date
           group by c.name order by 2 desc`),
        profit_and_loss: (await rows(db, sql`
          select coalesce(sum(l.credit - l.debit) filter (where a.type = 'income'), 0) as income,
                 coalesce(sum(l.debit - l.credit) filter (where a.type = 'expense'), 0) as expense,
                 coalesce(sum(l.credit - l.debit), 0) as net_profit
            from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
           where a.type in ('income', 'expense') and e.entry_date between ${from}::date and ${to}::date
             and e.ref_type <> 'year_close'`))[0],
      },
    });
  });
  return r;
}
