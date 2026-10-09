import { sql } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { addDays, can, istDate } from '@radcore/shared';
import { requireAuth, requirePerm } from '../core/auth';
import { rows, type DB } from '../db/client';
import { zDate } from '../lib/http';
import { gstSummary } from './gst';

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
                              where l.type <> 'rejected' group by m.item_id) s on s.item_id = i.id
                 where i.is_stock_item and i.active and i.reorder_level is not null and coalesce(s.qty, 0) < i.reorder_level)::int as low_stock,
               (select count(*) from stock_adjustments where status = 'pending')::int as adjustments_pending`);
    }
    if (money) {
      data.bank = await one(sql`select count(*)::int as unreconciled from bank_statement_lines where status = 'unmatched'`);
    }
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
    res.json({
      data: {
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
           where a.type in ('income', 'expense') and e.entry_date between ${from}::date and ${to}::date`))[0],
      },
    });
  });
  return r;
}
