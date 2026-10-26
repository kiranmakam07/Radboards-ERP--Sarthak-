'use client';

import { useState } from 'react';
import { GST_RETURN_LABELS, istDate, monthName } from '@radcore/shared';
import { ActionButton, Badge, Card, Form, Loading, Page, Stat, Table, date, inr, num } from '@/components/ui';
import { post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

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
      <FiledNote month={month} />
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
      <Filings month={month} />
    </Page>
  );
}

type Filing = { id: string; return_type: 'gstr1' | 'gstr3b'; period: string; filed_on: string; arn: string | null; marked_by: string | null };

/** Whether the month on screen is already filed: then its documents are closed (technical review, 26 Oct 2026). */
function FiledNote({ month }: { month: string }) {
  const filings = useGet<{ data: Filing[] }>('/gst/filings');
  const these = (filings.data?.data ?? []).filter((f) => f.period === month);
  if (these.length === 0) return null;
  return (
    <p className="muted">
      {these.map((f) => <span key={f.id}><Badge value="filed" /> {GST_RETURN_LABELS[f.return_type]} filed on {date(f.filed_on)}{f.arn ? ` (ARN ${f.arn})` : ''}. </span>)}
      Documents of {monthName(month)} that {these.length > 1 ? 'these returns report' : 'this return reports'} cannot be added or cancelled any more; correct them with a credit or debit note dated today.
    </p>
  );
}

/**
 * The months whose returns are filed on the portal. Marking one closes that month for the documents its
 * return reports: GSTR-1 for invoices and credit notes, GSTR-3B for purchase bills and debit notes.
 */
function Filings({ month }: { month: string }) {
  const can = useCan();
  const filings = useGet<{ data: Filing[] }>('/gst/filings');
  return (
    <Card title="Returns filed">
      <p className="muted small">
        Once a return is filed on the GST portal, mark it here. The documents of that month which the return reports can then no longer be
        added or cancelled, so the return cannot change behind it: a mistake found later is corrected with a credit or debit note dated today.
      </p>
      {can('gst:file') ? (
        <Form inline submit="Mark filed" initial={{ return_type: 'gstr1', period: month, filed_on: istDate(), arn: '' }}
          fields={[
            { name: 'return_type', label: 'Return', type: 'select', required: true, options: [{ value: 'gstr1', label: 'GSTR-1' }, { value: 'gstr3b', label: 'GSTR-3B' }] },
            { name: 'period', label: 'For the month', type: 'month', required: true },
            { name: 'filed_on', label: 'Filed on', type: 'date', required: true },
            { name: 'arn', label: 'ARN (acknowledgement no.)' },
          ]}
          onSubmit={(v) => post('/gst/filings', { ...v, arn: v.arn || undefined })} onDone={filings.reload} />
      ) : null}
      <Loading loading={filings.loading} error={filings.error} />
      <Table rows={filings.data?.data} empty="No return is marked filed yet." columns={[
        { key: 'return_type', title: 'Return', render: (f) => GST_RETURN_LABELS[f.return_type] },
        { key: 'period', title: 'Month', render: (f) => monthName(f.period) },
        { key: 'filed_on', title: 'Filed on', render: (f) => date(f.filed_on) },
        { key: 'arn', title: 'ARN' },
        { key: 'marked_by', title: 'Marked by' },
        ...(can('gst:unfile') ? [{ key: 'undo', title: '', render: (f: Filing) => (
          <ActionButton onClick={() => {
            const reason = window.prompt(`Why is ${GST_RETURN_LABELS[f.return_type]} for ${monthName(f.period)} no longer filed?`);
            return reason ? post(`/gst/filings/${f.id}/undo`, { reason }) : Promise.resolve();
          }} onDone={filings.reload}>Take back</ActionButton>
        ) }] : []),
      ]} />
    </Card>
  );
}
