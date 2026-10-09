'use client';

import Link from 'next/link';
import { Flow, type FlowStep } from '@/components/charts';
import { Page, inr } from '@/components/ui';
import { useGet } from '@/lib/api';
import { useCan, useSession } from '@/lib/session';

const TILES: [string, string, string][] = [
  ['/walk-in', 'Walk-in', 'leads:write'],
  ['/quick-bill', 'Quick bill', 'quickbill:create'],
  ['/leads/pipeline', 'Pipeline', 'leads:read'],
  ['/sales/orders', 'Quotes & orders', 'sales:read'],
  ['/purchasing/receipts', 'Inward & QC', 'grn:write'],
  ['/stock', 'Stock', 'stock:read'],
  ['/payments', 'Payments', 'payments:read'],
  ['/dashboards/sales', 'Sales dashboard', 'dashboard:sales'],
  ['/dashboards/marketing', 'Marketing dashboard', 'dashboard:marketing'],
  ['/dashboards/accounts', 'Accounts dashboard', 'dashboard:accounts'],
];

/**
 * Home: the business as a picture. Each box is a step in the flow with the number of things
 * waiting there right now; clicking it opens the list behind the number. People only see
 * the steps their role works on.
 */
export default function Home() {
  const { user } = useSession();
  const can = useCan();
  const { data } = useGet<{ data: any }>('/dashboards/overview');
  const o = data?.data;

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
  if (o?.bank) attention.push({ label: 'Bank lines to reconcile', value: o.bank.unreconciled, href: '/accounts/bank', alert: o.bank.unreconciled > 0 });

  return (
    <Page title={`Hello, ${user.name}`}>
      <Flow title="From enquiry to money in" steps={sale} />
      <Flow title="From purchase order to stock" steps={purchase} />
      <Flow title="Needs attention" steps={attention} arrows={false} />
      {/* Store screens are at most two taps away (PRD section 9). */}
      <div className="home-tiles">
        {TILES.filter(([, , perm]) => can(perm)).map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}
      </div>
    </Page>
  );
}
