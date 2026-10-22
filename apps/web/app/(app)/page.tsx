'use client';

import Link from 'next/link';
import { LEAD_STAGE_LABELS, istDate, type LeadStage } from '@radcore/shared';
import { Donut, Flow, LineChart, compactRupees, fillDays, rupees, type FlowStep } from '@/components/charts';
import { Icon } from '@/components/icons';
import { Card, Page, Stat, inr } from '@/components/ui';
import { useGet } from '@/lib/api';
import { NAV } from '@/lib/nav';
import { useCan, useSession } from '@/lib/session';

/**
 * Home: where to go, then the business at a glance. First a tile for each section of the app the
 * person may use (the same sections as the menu, lib/nav.ts), then a row of headline figures, the
 * month's sales and where the leads stand, then each flow as a row of steps with the number of things
 * waiting there right now; every figure opens the list behind it. People only see what their role
 * works on.
 */
export default function Home() {
  const { user } = useSession();
  const can = useCan();
  const { data } = useGet<{ data: any }>('/dashboards/overview');
  const sales = useGet<{ data: any }>(can('dashboard:sales') ? '/dashboards/sales' : null);
  const o = data?.data;
  const s = sales.data?.data;

  // ---- the headline figures ----
  const headline: { label: string; value: string; hint?: string; icon: string; tone?: 'green' | 'amber' | 'red'; href: string }[] = [];
  if (s) {
    const month = s.sales_month_to_date.reduce((t: number, r: any) => t + Number(r.value), 0);
    headline.push({ label: 'Sales this month', value: rupees(month), hint: `${s.sales_month_to_date.reduce((t: number, r: any) => t + r.invoices, 0)} invoices`, icon: 'trend', tone: 'green', href: '/dashboards/sales' });
  }
  if (o?.invoices) headline.push({ label: 'To collect', value: `₹${inr(o.invoices.outstanding ?? 0).replace(/\.00$/, '')}`, hint: `${o.invoices.unpaid} unpaid invoices`, icon: 'rupee', href: '/payments/reminders' });
  if (o?.leads) headline.push({ label: 'Leads in progress', value: String(o.leads.in_progress), hint: o.leads.follow_ups_due ? `${o.leads.follow_ups_due} follow-ups due` : `${o.leads.fresh} new`, icon: 'crm', tone: o.leads.follow_ups_due ? 'amber' : undefined, href: '/leads/pipeline' });
  if (o?.orders) headline.push({ label: 'Orders to deliver', value: String(o.orders.to_deliver), hint: `${o.orders.quotes} quotes waiting`, icon: 'sales', href: '/sales/orders' });
  if (o?.purchasing) headline.push({ label: 'Bills to pay', value: `₹${inr(o.purchasing.bills_outstanding ?? 0).replace(/\.00$/, '')}`, hint: `${o.purchasing.bills_unpaid} bills`, icon: 'accounts', href: '/purchasing/bills' });
  if (o?.stock) headline.push({ label: 'Low on stock', value: String(o.stock.low_stock), hint: 'items under their level', icon: 'stores', tone: o.stock.low_stock ? 'red' : 'green', href: '/stock' });
  if (o?.mine) headline.push({ label: 'My tasks today', value: String(o.mine.tasks_today), hint: o.mine.tasks_overdue ? `${o.mine.tasks_overdue} late` : 'none late', icon: 'operations', tone: o.mine.tasks_overdue ? 'red' : undefined, href: '/my-work' });

  // ---- the flows, step by step ----
  const sale: FlowStep[] = [];
  const purchase: FlowStep[] = [];
  const attention: FlowStep[] = [];
  if (o?.leads) {
    sale.push({ label: 'New leads', value: o.leads.fresh, note: 'not yet contacted', href: '/leads?stage=new' });
    sale.push({
      label: 'Leads in progress', value: o.leads.in_progress, href: '/leads/pipeline',
      note: o.leads.follow_ups_due ? `${o.leads.follow_ups_due} follow-ups due` : `${o.leads.converted_this_month} converted this month`,
      alert: o.leads.follow_ups_due > 0,
    });
  }
  if (o?.orders) {
    sale.push({ label: 'Quotes', value: o.orders.quotes, note: 'waiting to be confirmed', href: '/sales/orders' });
    sale.push({ label: 'Orders to deliver', value: o.orders.to_deliver, href: '/sales/orders' });
    sale.push({ label: 'Delivered, to invoice', value: o.orders.to_invoice, href: '/sales/orders', alert: o.orders.to_invoice > 0 });
  }
  if (o?.invoices) {
    sale.push({ label: 'Unpaid invoices', value: o.invoices.unpaid, note: o.invoices.outstanding ? `₹${inr(o.invoices.outstanding)} to collect` : undefined, href: '/invoices' });
  }
  if (o?.purchasing) {
    purchase.push({ label: 'Orders with suppliers', value: o.purchasing.awaiting_goods, note: 'goods not yet in', href: '/purchasing/orders' });
    purchase.push({ label: 'Waiting for QC', value: o.purchasing.waiting_qc, note: 'received, not in stock', href: '/purchasing/receipts', alert: o.purchasing.waiting_qc > 0 });
    purchase.push({ label: 'Rejects to return', value: o.purchasing.rejects_to_return, href: '/purchasing/receipts', alert: o.purchasing.rejects_to_return > 0 });
    purchase.push({
      label: 'Bills to pay', value: o.purchasing.bills_unpaid, href: '/purchasing/bills',
      note: o.purchasing.bills_outstanding ? `₹${inr(o.purchasing.bills_outstanding)} owed` : undefined,
    });
  }
  if (o?.stock) {
    attention.push({ label: 'Items low on stock', value: o.stock.low_stock, href: '/stock', alert: o.stock.low_stock > 0 });
    if (can('stock:approve') || can('stock:write')) {
      attention.push({ label: 'Stock changes to approve', value: o.stock.adjustments_pending, href: '/stock', alert: o.stock.adjustments_pending > 0 });
    }
  }
  // Only there while a battery is late for its storage charge: the owner's daily reminder.
  if (o?.units?.charge_due) {
    attention.push({ label: 'Batteries due a storage charge', value: o.units.charge_due, href: '/units?charge=1', alert: true });
  }
  if (o?.bank) attention.push({ label: 'Bank lines to reconcile', value: o.bank.unreconciled, href: '/accounts/bank', alert: o.bank.unreconciled > 0 });
  if (o?.ops) {
    attention.push({ label: 'Late tasks, everyone', value: o.ops.tasks_overdue, note: `${o.ops.tasks_open_today} still open today`, href: '/ops/tasks?view=overdue', alert: o.ops.tasks_overdue > 0 });
    attention.push({ label: 'Maintenance due', value: o.ops.maintenance_due, href: '/ops/assets', alert: o.ops.maintenance_due > 0 });
  }
  const hiring: FlowStep[] = [];
  if (o?.hiring) {
    hiring.push({ label: 'New applications', value: o.hiring.applied, note: 'to be screened', href: '/hr/applicants?stage=applied' });
    hiring.push({ label: 'Shortlisted', value: o.hiring.shortlisted, href: '/hr/applicants?stage=shortlisted' });
    hiring.push({ label: 'In interviews', value: o.hiring.interview, href: '/hr/applicants?stage=interview' });
    hiring.push({ label: 'Offer made', value: o.hiring.offered, href: '/hr/applicants?stage=offered' });
    hiring.push({ label: 'Hired this month', value: o.hiring.hired_this_month, note: `${o.hiring.open_positions} open positions`, href: '/hr/applicants?stage=hired' });
  }
  // What is sitting with the person signed in. Shown to everyone, first.
  const mine: FlowStep[] = [];
  if (o?.my_leads) {
    mine.push({ label: 'New leads for me', value: o.my_leads.fresh, note: 'not yet contacted', href: '/leads?stage=new&mine=true', alert: o.my_leads.fresh > 0 });
    mine.push({ label: 'My follow-ups due', value: o.my_leads.follow_ups_due, href: '/leads?view=followups_due&mine=true', alert: o.my_leads.follow_ups_due > 0 });
  }
  if (o?.mine) {
    mine.push({ label: 'My tasks today', value: o.mine.tasks_today, href: '/my-work' });
    mine.push({ label: 'My late tasks', value: o.mine.tasks_overdue, href: '/my-work', alert: o.mine.tasks_overdue > 0 });
    if (o.mine.maintenance_due > 0) mine.push({ label: 'Maintenance I look after', value: o.mine.maintenance_due, note: 'due now or soon', href: '/my-work', alert: true });
    if (o.mine.interviews > 0) mine.push({ label: 'Interviews to take', value: o.mine.interviews, href: '/my-work' });
  }

  const today = istDate();
  const monthStart = `${today.slice(0, 7)}-01`;
  // Each section the person can use, opening at its first screen they may see.
  const sections = NAV.map((g) => ({ ...g, first: g.items.find((i) => !i.perm || can(i.perm)) })).filter((g) => g.first);
  return (
    <Page title={`Hello, ${user.name.split(' ')[0]}`}>
      <div className="app-grid">
        {sections.map((g) => (
          <Link key={g.group} href={g.first!.href} className="app-tile">
            <span className="app-icon"><Icon name={g.icon} size={22} /></span>
            <span><strong>{g.group}</strong><span className="small">{g.blurb}</span></span>
          </Link>
        ))}
      </div>
      {headline.length > 0 && (
        <>
          <div className="section-title"><h2>General report</h2><span className="muted small">As of now</span></div>
          <div className="stats">{headline.slice(0, 6).map((h) => <Stat key={h.label} {...h} />)}</div>
        </>
      )}

      {s && (
        <div className="grid">
          <Card title="Sales this month" actions={<Link href="/dashboards/sales">Sales dashboard</Link>}>
            <LineChart points={fillDays((s.sales_by_day ?? []).filter((d: any) => d.day >= monthStart).map((d: any) => ({ day: d.day, value: Number(d.value) })), monthStart, today)}
              name="Sales" format={rupees} axisFormat={compactRupees} empty="No sales yet this month." />
          </Card>
          <Card title="Leads by stage" actions={<Link href="/leads/pipeline">Pipeline</Link>}>
            <Donut data={(s.pipeline ?? []).map((p: any) => ({ label: LEAD_STAGE_LABELS[p.stage as LeadStage] ?? p.stage, value: Number(p.count), href: `/leads?stage=${p.stage}` }))}
              caption="Leads" empty="No leads yet." />
          </Card>
          {s.top_items?.length > 0 && (
            <Card title="Best sellers this month">
              <ul className="rank">
                {s.top_items.slice(0, 5).map((t: any, i: number) => (
                  <li key={t.item_id}>
                    <span className="rank-no">{i + 1}</span>
                    <span className="rank-name">{t.item}<span className="muted small">{Number(t.qty)} sold</span></span>
                    <span className="badge green">{rupees(Number(t.revenue))}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      <Flow title="With me" steps={mine} arrows={false} />
      <Flow title="From enquiry to money in" steps={sale} />
      <Flow title="From purchase order to stock" steps={purchase} />
      <Flow title="From application to joining" steps={hiring} />
      <Flow title="Needs attention" steps={attention} arrows={false} />
    </Page>
  );
}
