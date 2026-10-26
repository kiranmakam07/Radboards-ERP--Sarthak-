'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { inr, num } from '@/components/ui';
import { post, useGet } from '@/lib/api';

/** A repair estimate as the customer opens it from the link we sent: they approve it or not. No sign-in. */
export default function EstimatePage() {
  const { token } = useParams<{ token: string }>();
  const { data, error, reload } = useGet<{ data: any }>(`/public/estimates/${token}`);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const e = data?.data;
  if (error) return <div className="center"><div className="card"><h1 style={{ marginBottom: 8 }}>This link is not available</h1><p className="muted">Ask the workshop for a new one.</p></div></div>;
  if (!e) return <div className="center muted">Loading…</div>;
  const answer = async (approve: boolean) => {
    setBusy(true); setProblem(null);
    try { await post(`/public/estimates/${token}/${approve ? 'approve' : 'decline'}`, {}); reload(); } catch (x) { setProblem((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="shared">
      <div className="card">
        <h1 style={{ marginBottom: 4 }}>{e.company.name}</h1>
        {e.company.phone ? <p className="muted small">{e.company.phone}</p> : null}
        <h2 style={{ marginTop: 16 }}>Estimate for your {e.item_name} ({e.serial_no})</h2>
        <p className="muted small">Job {e.job_no} · for {e.party_name}</p>
        <p><strong>You told us:</strong> {e.complaint}</p>
        {e.diagnosis ? <p><strong>We found:</strong> {e.diagnosis}</p> : null}
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            {/* Two columns, the quantity and rate under the name, so it fits a phone. */}
            <thead><tr><th>Work</th><th className="right">Amount</th></tr></thead>
            <tbody>
              {e.lines.map((l: any, i: number) => (
                <tr key={i}>
                  <td>{l.item_name}<div className="muted small">{num(l.qty)} x ₹{inr(l.rate)}</div></td>
                  <td className="right">{l.is_warranty ? <span className="badge green">Warranty · free</span> : inr(l.line_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="totals" style={{ marginTop: 10 }}>
          <div className="grand"><span>You pay, with GST</span><span>₹{inr(e.chargeable.grand_total)}</span></div>
          {Number(e.free.grand_total) ? <div className="muted"><span>Covered by your warranty</span><span>₹{inr(e.free.grand_total)}</span></div> : null}
        </div>
        {e.status === 'estimate_sent' ? (
          <div className="actions" style={{ marginTop: 16 }}>
            <button type="button" className="primary big" disabled={busy} onClick={() => void answer(true)}>Approve ₹{inr(e.chargeable.grand_total)}</button>
            <button type="button" disabled={busy} onClick={() => void answer(false)}>Not now</button>
          </div>
        ) : e.approved_at ? (
          <div className="notice" style={{ marginTop: 16 }}>Approved, thank you. We will tell you when it is ready.</div>
        ) : (
          <div className="notice" style={{ marginTop: 16 }}>The workshop is looking at this again and will send you an updated estimate.</div>
        )}
        {problem ? <div className="error" role="alert" style={{ marginTop: 8 }}>{problem}</div> : null}
      </div>
    </div>
  );
}
