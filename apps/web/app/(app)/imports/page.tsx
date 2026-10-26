'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { IMPORT_STAGES, IMPORT_STAGE_LABELS, type ImportStage } from '@radcore/shared';
import { CsvLink, ErrorBox, Loading, Modal, Page, Table, date, inr } from '@/components/ui';
import { post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/** Shipments from foreign suppliers, the stage each has reached, and their landed cost. */
export default function ImportsPage() {
  const can = useCan();
  const router = useRouter();
  const [f, setF] = useState({ q: '', stage: '' as ImportStage | '' });
  const [adding, setAdding] = useState(false);
  const path = `/imports${qs(f)}`;
  const { data, loading, error } = useGet<{ data: any[] }>(path);
  return (
    <Page title="Imports" actions={<>{can('imports:write') ? <button type="button" className="primary" onClick={() => setAdding(true)}>+ Shipment</button> : null}<CsvLink href={path} /></>}>
      <div className="filters">
        <input className="grow" placeholder="Search shipment, supplier, BL/AWB or bill of entry" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        <select value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value as ImportStage | '' })}>
          <option value="">Every stage</option>
          {IMPORT_STAGES.map((s) => <option key={s} value={s}>{IMPORT_STAGE_LABELS[s]}</option>)}
        </select>
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} rowHref={(r) => `/imports/${r.id}`} empty="No shipments yet." columns={[
        { key: 'shipment_no', title: 'Shipment', render: (r) => <strong>{r.shipment_no}</strong> },
        { key: 'supplier_name', title: 'Supplier' },
        { key: 'orders', title: 'Purchase orders' },
        { key: 'stage', title: 'Stage', render: (r) => <span className="badge">{IMPORT_STAGE_LABELS[r.stage as ImportStage]}</span> },
        { key: 'bl_awb_no', title: 'BL / AWB' },
        { key: 'costs', title: 'Landed cost ₹', align: 'right', render: (r) => <>{inr(r.costs)}{Number(r.costs_open) ? <div className="muted small">₹{inr(r.costs_open)} not on the goods yet</div> : null}</> },
        { key: 'created_at', title: 'Opened', render: (r) => date(r.created_at) },
      ]} />
      {adding ? <NewShipment onClose={() => setAdding(false)} onDone={(id) => router.push(`/imports/${id}`)} /> : null}
    </Page>
  );
}

function NewShipment({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const suppliers = useGet<{ data: any[] }>('/parties?type=supplier&limit=2000');
  const [v, setV] = useState({ supplier_id: '', currency: 'USD', fx_rate: '', bl_awb_no: '' });
  const [orders, setOrders] = useState<string[]>([]);
  const pos = useGet<{ data: any[] }>(v.supplier_id ? `/purchasing/orders${qs({ supplier_id: v.supplier_id, limit: 200 })}` : null);
  const [error, setError] = useState<string | null>(null);
  const open = (pos.data?.data ?? []).filter((p) => !['draft', 'cancelled'].includes(p.status));
  return (
    <Modal title="New import shipment" onClose={onClose}>
      <div className="form">
        <label><span>Supplier</span>
          <select value={v.supplier_id} onChange={(e) => { setV({ ...v, supplier_id: e.target.value }); setOrders([]); }}>
            <option value="">Pick one</option>
            {(suppliers.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label><span>Currency</span><input value={v.currency} onChange={(e) => setV({ ...v, currency: e.target.value.toUpperCase() })} /></label>
        <label><span>Rupees to one (optional)</span><input type="number" step="any" value={v.fx_rate} onChange={(e) => setV({ ...v, fx_rate: e.target.value })} /></label>
        <label><span>BL / AWB number</span><input value={v.bl_awb_no} onChange={(e) => setV({ ...v, bl_awb_no: e.target.value })} /></label>
      </div>
      {v.supplier_id ? (
        <div style={{ marginTop: 10 }}>
          <span className="small">Purchase orders on this shipment</span>
          <div className="chips">
            {open.length === 0 && pos.data ? <span className="muted small">No sent purchase orders for this supplier.</span> : null}
            {open.map((p) => (
              <button key={p.id} type="button" className={`chip${orders.includes(p.id) ? ' on' : ''}`} aria-pressed={orders.includes(p.id)}
                onClick={() => setOrders(orders.includes(p.id) ? orders.filter((x) => x !== p.id) : [...orders, p.id])}>{p.po_no}</button>
            ))}
          </div>
        </div>
      ) : null}
      <ErrorBox error={error} />
      <div className="form-foot">
        <button type="button" className="primary" onClick={async () => {
          setError(null);
          try {
            const r = await post<{ data: { id: string } }>('/imports', { supplier_id: v.supplier_id, purchase_order_ids: orders, currency: v.currency, fx_rate: v.fx_rate || null, bl_awb_no: v.bl_awb_no || null });
            onDone(r.data.id);
          } catch (e) { setError((e as Error).message); }
        }}>Open shipment</button>
      </div>
    </Modal>
  );
}
