'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { STATE_CODES } from '@radcore/shared';
import { Loading, Page, addr, date, inr, num } from '@/components/ui';
import { useGet } from '@/lib/api';

/**
 * The delivery challan the material travels on. No tax is charged: this is not a sale, the goods
 * stay ours. It carries what the GST rules ask of such a challan: both parties with their GSTIN,
 * the HSN code, quantity and value of each item, and what the goods are being sent for.
 */
export default function JobWorkChallanPrintPage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error } = useGet<{ data: any }>(`/jobwork/${id}`);
  const j = data?.data;
  if (!j) return <Page title="Job work challan"><Loading loading={loading} error={error} /></Page>;
  const c = j.company;
  const total = j.lines.reduce((s: number, l: any) => s + Number(l.value), 0);
  const otherState = j.job_worker_state && j.job_worker_state !== c.state_code;

  return (
    <Page title={`Job work challan ${j.challan_no}`} actions={
      <>
        <button type="button" className="primary" onClick={() => window.print()}>Print / Save PDF</button>
        <Link className="button" href={`/jobwork/${id}`}>Back to the challan</Link>
      </>
    }>
      <div className="doc">
        <h1>DELIVERY CHALLAN</h1>
        <p style={{ textAlign: 'center', margin: '0 0 8px' }}>Goods sent for job work. Not a sale.</p>
        {j.status === 'cancelled' && <p style={{ textAlign: 'center' }}><span className="cancelled-stamp">CANCELLED</span></p>}
        <div className="head">
          <div>
            <strong>From: {c.name}</strong><br />
            {addr(c.address)}<br />
            {c.gstin && <>GSTIN: {c.gstin}<br /></>}
            State: {STATE_CODES[c.state_code]} ({c.state_code})
            {c.phone && <><br />Phone: {c.phone}</>}
          </div>
          <div>
            <strong>Challan no:</strong> {j.challan_no}<br />
            <strong>Date:</strong> {date(j.challan_date)}<br />
            <strong>Sent from:</strong> {j.from_location}<br />
            {j.transport && <><strong>Vehicle / transporter:</strong> {j.transport}<br /></>}
            {j.expected_back_on && <><strong>Expected back:</strong> {date(j.expected_back_on)}</>}
          </div>
        </div>
        <div className="head">
          <div>
            <strong>To the job worker</strong><br />
            {j.job_worker_name}<br />
            {addr(j.job_worker_address)}{addr(j.job_worker_address) && <br />}
            {j.job_worker_phone && <>Phone: {j.job_worker_phone}<br /></>}
            {j.job_worker_gstin ? <>GSTIN: {j.job_worker_gstin}<br /></> : <>Not registered under GST<br /></>}
            {j.job_worker_state && <>State: {STATE_CODES[j.job_worker_state]} ({j.job_worker_state})</>}
          </div>
          <div>
            <strong>Sent for:</strong> {j.process}
            {otherState ? <><br /><strong>Place of supply:</strong> {STATE_CODES[j.job_worker_state]} ({j.job_worker_state})</> : null}
          </div>
        </div>
        <table>
          <thead>
            <tr><th>#</th><th>Description</th><th>HSN</th><th className="right">Quantity</th><th className="right">Rate ₹</th><th className="right">Value ₹</th></tr>
          </thead>
          <tbody>
            {j.lines.map((l: any, i: number) => (
              <tr key={l.id}>
                <td>{i + 1}</td><td>{l.name} <span className="small">({l.sku})</span></td><td>{l.hsn_sac}</td>
                <td className="right">{num(l.qty)} {l.unit}</td><td className="right">{inr(l.unit_cost)}</td><td className="right">{inr(l.value)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={5}>Value of the goods</td><td className="right">{inr(total)}</td></tr></tfoot>
        </table>
        <p className="small">
          These goods are sent for job work and remain the property of {c.name}. No tax is charged on this challan. They are to be returned after the work,
          and in any case within one year of the date above.
        </p>
        {j.notes && <p className="small">Notes: {j.notes}</p>}
        <div className="head" style={{ marginTop: 28 }}>
          <div>Received the above goods in good order<br /><br /><br />Signature of the job worker</div>
          <div style={{ textAlign: 'right' }}>For {c.name}<br /><br /><br />Authorised signatory</div>
        </div>
      </div>
    </Page>
  );
}
