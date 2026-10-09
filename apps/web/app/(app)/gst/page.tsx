'use client';

import { useState } from 'react';
import { istDate } from '@radcore/shared';
import { Card, Loading, Page, Stat, Table, date, inr, num } from '@/components/ui';
import { useGet } from '@/lib/api';

const SECTIONS: [string, string][] = [
  ['b2b', 'B2B invoices'], ['b2cl', 'B2C large (inter-state)'], ['b2cs', 'B2C small'], ['cdnr', 'Credit notes (registered)'],
  ['cdnur', 'Credit notes (unregistered)'], ['hsn', 'HSN summary'], ['docs', 'Documents issued'],
];
const TAX = [
  { key: 'taxable_value', title: 'Taxable', align: 'right' as const, render: (r: any) => inr(r.taxable_value) },
  { key: 'igst', title: 'IGST', align: 'right' as const, render: (r: any) => inr(r.igst) },
  { key: 'cgst', title: 'CGST', align: 'right' as const, render: (r: any) => inr(r.cgst) },
  { key: 'sgst', title: 'SGST', align: 'right' as const, render: (r: any) => inr(r.sgst) },
];
const POS = { key: 'place_of_supply', title: 'Place of supply', render: (r: any) => `${r.place_of_supply}-${r.place_of_supply_name}` };
const RATE = { key: 'rate', title: 'Rate %', align: 'right' as const, render: (r: any) => num(r.rate) };

export default function GstPage() {
  const [month, setMonth] = useState(istDate().slice(0, 7));
  const [section, setSection] = useState('b2b');
  const g3 = useGet<{ data: any }>(`/gst/gstr3b?month=${month}`);
  const g1 = useGet<{ data: any }>(`/gst/gstr1?month=${month}`);
  const s = g3.data?.data;
  const rows = g1.data?.data?.[section];

  const columns: Record<string, any[]> = {
    b2b: [{ key: 'gstin', title: 'GSTIN' }, { key: 'receiver_name', title: 'Receiver' }, { key: 'invoice_no', title: 'Invoice' }, { key: 'invoice_date', title: 'Date', render: (r: any) => date(r.invoice_date) }, { key: 'invoice_value', title: 'Value', align: 'right', render: (r: any) => inr(r.invoice_value) }, POS, RATE, ...TAX],
    b2cl: [{ key: 'invoice_no', title: 'Invoice' }, { key: 'invoice_date', title: 'Date', render: (r: any) => date(r.invoice_date) }, { key: 'invoice_value', title: 'Value', align: 'right', render: (r: any) => inr(r.invoice_value) }, POS, RATE, ...TAX],
    b2cs: [POS, RATE, ...TAX],
    cdnr: [{ key: 'gstin', title: 'GSTIN' }, { key: 'receiver_name', title: 'Receiver' }, { key: 'note_no', title: 'Note' }, { key: 'note_date', title: 'Date', render: (r: any) => date(r.note_date) }, { key: 'original_invoice_no', title: 'Against' }, { key: 'note_value', title: 'Value', align: 'right', render: (r: any) => inr(r.note_value) }, RATE, ...TAX],
    cdnur: [{ key: 'note_no', title: 'Note' }, { key: 'note_date', title: 'Date', render: (r: any) => date(r.note_date) }, { key: 'original_invoice_no', title: 'Against' }, { key: 'note_value', title: 'Value', align: 'right', render: (r: any) => inr(r.note_value) }, POS, RATE, ...TAX],
    hsn: [{ key: 'hsn', title: 'HSN/SAC' }, { key: 'uqc', title: 'Unit' }, RATE, { key: 'total_qty', title: 'Qty', align: 'right', render: (r: any) => num(r.total_qty) }, { key: 'total_value', title: 'Value', align: 'right', render: (r: any) => inr(r.total_value) }, ...TAX],
    docs: [{ key: 'document', title: 'Document' }, { key: 'from_no', title: 'From' }, { key: 'to_no', title: 'To' }, { key: 'total', title: 'Total', align: 'right' }, { key: 'cancelled', title: 'Cancelled', align: 'right' }, { key: 'net_issued', title: 'Net issued', align: 'right' }],
  };

  return (
    <Page title="GST">
      <div className="filters"><label>Month <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label></div>
      <Loading loading={g3.loading} error={g3.error} />
      {s && (
        <>
          <div className="stats">
            <Stat label="Output tax" value={`₹${inr(s.outward.total_tax)}`} hint={`on ₹${inr(s.outward.net.taxable)} taxable`} />
            <Stat label="Input tax credit" value={`₹${inr(s.itc.total_tax)}`} hint="purchases + expenses − debit notes" />
            <Stat label="Estimated net payable" value={`₹${inr(s.net_payable.total)}`} hint="before portal set-off rules" />
          </div>
          <Card title="GSTR-3B summary">
            <Table rows={[
              { row: '3.1(a) Outward taxable supplies (net of credit notes)', ...s.outward.net },
              { row: '4(A) Input tax credit (net of debit notes)', ...s.itc.net },
              { row: 'Net payable (output − ITC)', taxable: '', ...s.net_payable },
            ]} columns={[
              { key: 'row', title: '' },
              { key: 'taxable', title: 'Taxable value', align: 'right', render: (r) => inr(r.taxable) },
              { key: 'igst', title: 'IGST', align: 'right', render: (r) => inr(r.igst) },
              { key: 'cgst', title: 'CGST', align: 'right', render: (r) => inr(r.cgst) },
              { key: 'sgst', title: 'SGST', align: 'right', render: (r) => inr(r.sgst) },
            ]} />
          </Card>
        </>
      )}
      <Card title="GSTR-1" actions={
        <>
          <a className="button primary" href={`/api/gst/gstr1/portal-file?month=${month}`}>File for the GST portal</a>
          <a className="button" href={`/api/gst/gstr1?month=${month}&section=${section}&format=xlsx`}>This section (Excel)</a>
          <a className="button" href={`/api/gst/gstr1?month=${month}&section=${section}&format=csv`}>CSV</a>
        </>
      }>
        <div className="filters">
          {SECTIONS.map(([k, l]) => <button key={k} type="button" className={section === k ? 'primary' : undefined} onClick={() => setSection(k)}>{l}{g1.data?.data?.[k]?.length ? ` (${g1.data.data[k].length})` : ''}</button>)}
        </div>
        <Loading loading={g1.loading} error={g1.error} />
        <Table rows={rows} empty="Nothing in this section for the month." columns={columns[section]!} />
        <p className="muted small">Have your CA check the first filing against the GST portal before relying on these exports.</p>
      </Card>
    </Page>
  );
}
