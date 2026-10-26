'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { IMPORT_STAGES, IMPORT_STAGE_LABELS, LANDED_COST_BASES, LANDED_COST_KINDS, istDate, type ImportStage } from '@radcore/shared';
import { ActionButton, Card, FormModal, KV, Loading, Page, SmartButton, StatusBar, Table, date, inr, label, num } from '@/components/ui';
import { api, patch, post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

const KIND_LABELS: Record<string, string> = {
  freight: 'Freight', insurance: 'Insurance', bcd: 'Basic customs duty', sws: 'Social welfare surcharge', igst: 'IGST (input credit)',
  cha: 'Customs agent', port: 'Port and CFS', inland: 'Inland transport', other: 'Other',
};

/**
 * One shipment: its stages along the top, its purchase orders and goods, and its landed cost: each cost, where it
 * came from, how it is spread, and what each item costs once landed. Applying puts the open costs on the goods.
 */
export default function ShipmentPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const write = can('imports:write');
  const poster = can('imports:post');
  const { data, loading, error, reload } = useGet<{ data: any }>(`/imports/${id}`);
  const [open, setOpen] = useState<'stage' | 'paid' | 'bill' | 'details' | null>(null);
  const preview = useGet<{ data: any }>(data?.data && data.data.goods.length && data.data.costs.some((c: any) => !c.application_id && c.kind !== 'igst') ? `/imports/${id}/preview` : null);
  const services = useGet<{ data: any[] }>(open === 'bill' ? '/items?type=service&limit=500' : null);
  const suppliers = useGet<{ data: any[] }>(open === 'bill' ? '/parties?type=supplier&limit=2000' : null);
  const banks = useGet<{ data: any[] }>(open === 'paid' ? '/accounting/accounts' : null);
  const s = data?.data;
  if (!s) return <Page title="Shipment"><Loading loading={loading} error={error} /></Page>;
  const step = IMPORT_STAGES.indexOf(s.stage);
  const openCosts = s.costs.filter((c: any) => !c.application_id && c.kind !== 'igst');
  const total = s.costs.filter((c: any) => c.kind !== 'igst').reduce((a: number, c: any) => a + Number(c.amount), 0);

  return (
    <Page title={`Shipment ${s.shipment_no}`}
      smart={
        <>
          <SmartButton icon="stores" value={s.supplier_name} label="Supplier" href={`/parties/${s.supplier_id}`} />
          <SmartButton icon="rupee" value={`₹${inr(total)}`} label={openCosts.length ? `Landed cost · ₹${inr(openCosts.reduce((a: number, c: any) => a + Number(c.amount), 0))} open` : 'Landed cost'} />
        </>
      }
      status={<StatusBar steps={IMPORT_STAGES.map((x) => IMPORT_STAGE_LABELS[x])} current={step} />}
      actions={
        <>
          {write ? <button type="button" className="primary" onClick={() => setOpen('stage')}>Record a stage</button> : null}
          {write ? <button type="button" onClick={() => setOpen('details')}>BL and bill of entry</button> : null}
          {poster ? <button type="button" onClick={() => setOpen('paid')}>+ Cost paid</button> : null}
          {can('bills:write') ? <button type="button" onClick={() => setOpen('bill')}>+ Forwarder&apos;s or agent&apos;s bill</button> : null}
          {poster && openCosts.length && s.goods.length ? (
            <ActionButton kind="primary" confirm={`Put ₹${inr(preview.data?.data.total ?? 0)} of landed cost on the goods? Applied costs cannot be changed.`}
              onClick={() => post(`/imports/${id}/apply`, {})} onDone={() => { reload(); preview.reload(); }}>Put costs on the goods</ActionButton>
          ) : null}
        </>
      }>
      <div className="grid">
        <Card title="The shipment">
          <KV rows={[
            ['Currency', `${s.currency}${s.fx_rate ? ` at ₹${Number(s.fx_rate)}` : ''}`], ['BL / AWB', s.bl_awb_no],
            ['Bill of entry', s.boe_no ? `${s.boe_no}${s.boe_date ? `, ${date(s.boe_date)}` : ''}` : null], ['Notes', s.notes],
          ]} />
        </Card>
        <Card title="Stages">
          <Table rows={IMPORT_STAGES.filter((x) => s.stage_dates[x]).map((x) => ({ stage: x, on: s.stage_dates[x] }))} empty="None yet." columns={[
            { key: 'stage', title: 'Stage', render: (r) => IMPORT_STAGE_LABELS[r.stage as ImportStage] }, { key: 'on', title: 'On', render: (r) => date(r.on) },
          ]} />
        </Card>
      </div>

      <Card title="Purchase orders">
        <Table rows={s.orders} rowHref={(o) => `/purchasing/orders/${o.id}`} empty="None on this shipment." columns={[
          { key: 'po_no', title: 'PO' }, { key: 'order_date', title: 'Date', render: (o) => date(o.order_date) }, { key: 'status', title: 'Status', render: (o) => label(o.status) },
          { key: 'currency', title: 'Currency', render: (o) => `${o.currency}${o.fx_rate && o.currency !== 'INR' ? ` at ₹${Number(o.fx_rate)}` : ''}` },
        ]} />
      </Card>

      <Card title="Landed cost">
        <Table rows={s.costs} empty="No costs yet: a forwarder's or customs agent's bill, or a cost paid (the duty on the bill of entry)." columns={[
          { key: 'kind', title: 'Cost', render: (c) => <>{KIND_LABELS[c.kind]}{c.description ? <div className="muted small">{c.description}</div> : null}</> },
          { key: 'from', title: 'From', render: (c) => (c.purchase_bill_id ? <Link href={`/purchasing/bills/${c.purchase_bill_id}`}>{c.billed_by} · {c.supplier_invoice_no}</Link> : `Paid from ${c.paid_from}`) },
          { key: 'basis', title: 'Spread by', render: (c) => (c.kind === 'igst' ? <span className="muted small">Not spread: input credit</span> : !c.application_id && poster ? (
            <select value={c.basis} onChange={(e) => void patch(`/imports/${id}/costs/${c.id}`, { basis: e.target.value }).then(() => { reload(); preview.reload(); })}>
              {LANDED_COST_BASES.map((b) => <option key={b} value={b}>{label(b)}</option>)}
            </select>
          ) : label(c.basis)) },
          { key: 'amount', title: 'Amount ₹', align: 'right', render: (c) => inr(c.amount) },
          { key: 'applied_on', title: 'On the goods', render: (c) => (c.kind === 'igst' ? '' : c.applied_on ? date(c.applied_on) : <span className="badge amber">Not yet</span>) },
          { key: 'x', title: '', render: (c) => (poster && !c.application_id && c.paid_from_account_id ? (
            <ActionButton confirm="Take this cost off? Its entry in the books is reversed." onClick={() => api(`/imports/${id}/costs/${c.id}`, { method: 'DELETE' })} onDone={() => { reload(); preview.reload(); }}>Remove</ActionButton>
          ) : null) },
        ]} />
        {preview.data?.data.items?.length ? (
          <div style={{ marginTop: 12 }}>
            <p className="small"><strong>Not yet on the goods: ₹{inr(preview.data.data.total)}.</strong> Applying it would add:</p>
            <Table rows={preview.data.data.items} columns={[
              { key: 'item_name', title: 'Item' }, { key: 'qty', title: 'Qty', align: 'right', render: (r) => num(r.qty) },
              { key: 'per_unit', title: 'Each ₹', align: 'right', render: (r) => inr(r.per_unit) },
              { key: 'to_stock', title: 'To stock ₹', align: 'right', render: (r) => inr(r.to_stock) },
              { key: 'to_cogs', title: 'To cost of goods sold ₹', align: 'right', render: (r) => inr(r.to_cogs) },
            ]} />
          </div>
        ) : null}
      </Card>

      <Card title="Goods received">
        <Table rows={s.goods} empty="Nothing received and passed by QC yet." columns={[
          { key: 'grn_no', title: 'Receipt' }, { key: 'item_name', title: 'Item', render: (g) => <>{g.item_name} <span className="muted small">{g.sku}</span></> },
          { key: 'accepted', title: 'Accepted', align: 'right', render: (g) => num(g.accepted) },
          { key: 'rate', title: 'Cost each ₹', align: 'right', render: (g) => inr(g.rate) },
          { key: 'landed', title: 'Landed cost ₹', align: 'right', render: (g) => inr(g.landed) },
          { key: 'landed_each', title: 'Landed each ₹', align: 'right', render: (g) => <strong>{inr(g.landed_each)}</strong> },
        ]} />
      </Card>

      {open === 'stage' ? (
        <FormModal title="Record a stage" submit="Save" onClose={() => setOpen(null)} onDone={reload}
          initial={{ stage: IMPORT_STAGES[Math.min(step + 1, IMPORT_STAGES.length - 1)], on: istDate() }}
          fields={[
            { name: 'stage', label: 'Stage', type: 'select', required: true, options: IMPORT_STAGES.map((x) => ({ value: x, label: IMPORT_STAGE_LABELS[x] })) },
            { name: 'on', label: 'On', type: 'date', required: true },
          ]}
          onSubmit={(v) => post(`/imports/${id}/stage`, v)} />
      ) : null}
      {open === 'details' ? (
        <FormModal title="BL and bill of entry" submit="Save" onClose={() => setOpen(null)} onDone={reload}
          initial={{ bl_awb_no: s.bl_awb_no ?? '', boe_no: s.boe_no ?? '', boe_date: s.boe_date ?? '', fx_rate: s.fx_rate ? String(Number(s.fx_rate)) : '', notes: s.notes ?? '' }}
          fields={[
            { name: 'bl_awb_no', label: 'BL / AWB number' }, { name: 'boe_no', label: 'Bill of entry number' }, { name: 'boe_date', label: 'Bill of entry date', type: 'date' },
            { name: 'fx_rate', label: `Rupees to one ${s.currency}`, type: 'number' }, { name: 'notes', label: 'Notes', type: 'textarea' },
          ]}
          onSubmit={(v) => patch(`/imports/${id}`, { bl_awb_no: v.bl_awb_no || null, boe_no: v.boe_no || null, boe_date: v.boe_date || null, fx_rate: v.fx_rate || null, notes: v.notes || null })} />
      ) : null}
      {open === 'paid' ? (
        <FormModal title="A cost paid" submit="Book it" onClose={() => setOpen(null)} onDone={() => { reload(); preview.reload(); }}
          intro={<p className="muted small">The duty on the bill of entry, port charges paid there and then. IGST paid at customs is booked as input credit and is not spread over the goods.</p>}
          initial={{ kind: 'bcd', basis: 'value', paid_on: istDate() }}
          fields={[
            { name: 'kind', label: 'Cost', type: 'select', required: true, options: LANDED_COST_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k]! })) },
            { name: 'amount', label: 'Amount ₹', type: 'number', required: true },
            { name: 'basis', label: 'Spread by', type: 'select', required: true, options: LANDED_COST_BASES.map((b) => ({ value: b, label: label(b) })) },
            { name: 'paid_from_account_id', label: 'Paid from', type: 'select', required: true, options: (banks.data?.data ?? []).filter((a) => a.subtype && !a.is_group && a.active).map((a) => ({ value: a.id, label: a.name })) },
            { name: 'paid_on', label: 'Paid on', type: 'date', required: true }, { name: 'description', label: 'Note (challan, bill of entry)' },
          ]}
          onSubmit={(v) => post(`/imports/${id}/costs`, { ...v, description: v.description || null })} />
      ) : null}
      {open === 'bill' ? (
        <FormModal title="A forwarder's or customs agent's bill" submit="Book the bill" onClose={() => setOpen(null)} onDone={() => { reload(); preview.reload(); }}
          intro={<p className="muted small">Booked as their purchase bill, with its GST as input credit; the amount before GST becomes this shipment's cost. It is paid like any supplier's bill, under Payments.</p>}
          initial={{ bill_date: istDate(), landed_kind: 'freight' }}
          fields={[
            { name: 'supplier_id', label: 'Their name', type: 'select', required: true, options: (suppliers.data?.data ?? []).map((p) => ({ value: p.id, label: p.name })) },
            { name: 'supplier_invoice_no', label: 'Their invoice number', required: true }, { name: 'bill_date', label: 'Invoice date', type: 'date', required: true },
            { name: 'item_id', label: 'Charged for', type: 'select', required: true, options: (services.data?.data ?? []).map((x) => ({ value: x.id, label: `${x.name} (GST ${Number(x.gst_rate)}%)` })) },
            { name: 'landed_kind', label: 'Cost', type: 'select', required: true, options: LANDED_COST_KINDS.filter((k) => k !== 'igst').map((k) => ({ value: k, label: KIND_LABELS[k]! })) },
            { name: 'amount', label: 'Amount before GST ₹', type: 'number', required: true },
          ]}
          onSubmit={(v) => post('/purchasing/bills', {
            supplier_id: v.supplier_id, supplier_invoice_no: v.supplier_invoice_no, bill_date: v.bill_date, import_shipment_id: id,
            lines: [{ item_id: v.item_id, qty: 1, rate: v.amount, landed_kind: v.landed_kind, description: `${KIND_LABELS[v.landed_kind]}, shipment ${s.shipment_no}` }],
          })} />
      ) : null}
    </Page>
  );
}
