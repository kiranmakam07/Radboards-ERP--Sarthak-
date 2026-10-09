'use client';

import Link from 'next/link';
import { BarList, ChartCard, Flow, LineChart, compactRupees, fillDays, rupees } from '@/components/charts';
import { useRange } from '@/components/range';
import { Card, Loading, Page, Stat, Table, date, inr, label, num } from '@/components/ui';
import { useGet } from '@/lib/api';

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

export default function StoresDashboard() {
  const { query, picker } = useRange();
  const { data, loading, error } = useGet<{ data: any }>(`/dashboards/stores${query}`);
  const d = data?.data;
  const total = d ? d.value_by_location.reduce((s: number, l: any) => s + Number(l.value), 0) : 0;
  const lateOrders = d ? d.awaiting_goods.filter((o: any) => o.late).length : 0;
  const perDay = (key: 'value_in' | 'value_out') =>
    fillDays(d.movements_by_day.map((r: any) => ({ day: r.day, value: Number(r[key]) })), d.range.from, d.range.to);

  return (
    <Page title="Stores dashboard">
      {picker}
      <Loading loading={loading} error={error} />
      {d && (
        <>
          <Flow title="Needs attention" arrows={false} steps={[
            { label: 'Items below reorder level', value: d.low_stock.length, href: '/stock', alert: d.low_stock.length > 0 },
            { label: 'Orders with suppliers', value: d.awaiting_goods.length, note: lateOrders ? `${lateOrders} past the expected date` : 'goods not yet in', href: '/purchasing/orders', alert: lateOrders > 0 },
            { label: 'Waiting for QC', value: d.waiting_qc.length, note: 'received, not in stock', href: '/purchasing/receipts', alert: d.waiting_qc.length > 0 },
            { label: 'Rejects to return', value: d.rejects_to_return.receipts, note: Number(d.rejects_to_return.qty) ? `${num(d.rejects_to_return.qty)} units` : undefined, href: '/purchasing/receipts', alert: d.rejects_to_return.receipts > 0 },
            { label: 'Stock changes to approve', value: d.adjustments_pending.count, href: '/stock', alert: d.adjustments_pending.count > 0 },
          ]} />

          <div className="stats">
            <Stat label="Stock value" value={`₹${inr(total)}`} hint="at average cost, all locations" />
            {d.value_by_location.map((l: any) => <Stat key={l.id} label={l.name} value={`₹${inr(l.value)}`} hint={`${l.items} items`} />)}
          </div>

          <div className="grid">
            <ChartCard title="Goods in per day, by value" table={
              <Table rows={d.movements_by_day} empty="Nothing moved in this period." columns={[
                { key: 'day', title: 'Day', render: (r) => date(r.day) }, { key: 'value_in', title: 'In', align: 'right', render: (r) => inr(r.value_in) },
                { key: 'value_out', title: 'Out', align: 'right', render: (r) => inr(r.value_out) },
              ]} />
            }>
              <LineChart name="came in" format={rupees} axisFormat={compactRupees} empty="Nothing came in during this period." points={perDay('value_in')} />
            </ChartCard>

            <ChartCard title="Goods out per day, by value">
              <LineChart name="went out" format={rupees} axisFormat={compactRupees} empty="Nothing went out during this period." points={perDay('value_out')} />
            </ChartCard>

            <ChartCard title="Stock value by kind of item">
              <BarList format={rupees} empty="No stock yet." data={d.value_by_type.map((t: any) => ({ label: label(t.item_type), value: Number(t.value) }))} />
            </ChartCard>

            <ChartCard title="Fastest sellers, by units" actions={<Link href="/stock">Stock</Link>}>
              <BarList empty="Nothing sold in this period."
                data={d.fast_movers.map((i: any) => ({ label: i.name, value: Number(i.qty_out), note: i.sku }))} />
            </ChartCard>

            <ChartCard title="Running low">
              <BarList empty="Everything is above its reorder level."
                data={d.low_stock.map((i: any) => ({ label: i.name, value: Number(i.qty), note: `reorder at ${num(i.reorder_level)} ${i.unit}` }))} />
            </ChartCard>

            <Card title="Orders with suppliers" actions={<Link href="/purchasing/orders">Purchase orders</Link>}>
              <Table rows={d.awaiting_goods} empty="Nothing on order." rowHref={(r) => `/purchasing/orders/${r.id}`} columns={[
                { key: 'po_no', title: 'Order' }, { key: 'supplier', title: 'Supplier' },
                { key: 'expected_date', title: 'Expected', render: (r) => (r.expected_date ? <span className={r.late ? 'error small' : undefined}>{date(r.expected_date)}</span> : <span className="muted">not given</span>) },
                { key: 'days_waiting', title: '', render: (r) => (r.late ? `${days(r.days_waiting)} late` : '') },
              ]} />
            </Card>

            <Card title="Received, waiting for QC" actions={<Link href="/purchasing/receipts">Inward &amp; QC</Link>}>
              <Table rows={d.waiting_qc} empty="Nothing waiting." rowHref={(r) => `/purchasing/receipts/${r.id}`} columns={[
                { key: 'grn_no', title: 'Receipt' }, { key: 'supplier', title: 'Supplier' },
                { key: 'days_waiting', title: 'Waiting', align: 'right', render: (r) => (r.days_waiting ? days(r.days_waiting) : 'today') },
              ]} />
            </Card>
          </div>

          <Card title="In stock, but nothing sold or used for 90 days">
            <Table rows={d.not_moving} empty="Nothing has been sitting that long." columns={[
              { key: 'name', title: 'Item' }, { key: 'sku', title: 'SKU' },
              { key: 'qty', title: 'In stock', align: 'right', render: (r) => num(r.qty) },
              { key: 'value', title: 'Value', align: 'right', render: (r) => inr(r.value) },
              { key: 'last_out', title: 'Last went out', render: (r) => (r.last_out ? date(r.last_out) : 'never') },
            ]} />
          </Card>
        </>
      )}
    </Page>
  );
}
