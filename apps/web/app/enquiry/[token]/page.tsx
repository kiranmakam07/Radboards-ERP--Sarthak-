'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorBox } from '@/components/ui';
import { post, useGet } from '@/lib/api';

/** Public enquiry form behind a campaign QR code / short link. No login. */
export default function EnquiryPage() {
  const { token } = useParams<{ token: string }>();
  const { data, error } = useGet<{ data: { campaign: string; products: { id: string; name: string }[] } }>(`/public/campaign/${token}`);
  const [v, setV] = useState({ name: '', phone: '', item: '', message: '', website: '' });
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (error) return <div className="center"><div className="card">This enquiry link is not active.</div></div>;
  if (sent) return <div className="center"><div className="card"><h1>Thank you!</h1><p>We have your details and will call you shortly.</p></div></div>;

  return (
    <div className="center touch">
      <div className="card">
        <h1 style={{ marginBottom: 12 }}>Radboards — enquiry</h1>
        <form className="form" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true); setErr(null);
          try {
            await post(`/public/enquiry/${token}`, {
              name: v.name, phone: v.phone, message: v.message, interested_item_ids: v.item ? [v.item] : [], website: v.website,
            });
            setSent(true);
          } catch (ex) {
            setErr((ex as Error).message);
          } finally {
            setBusy(false);
          }
        }}>
          <label><span>Your name *</span><input required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></label>
          <label><span>Mobile number *</span><input required type="tel" inputMode="numeric" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} /></label>
          <label><span>Interested in</span>
            <select value={v.item} onChange={(e) => setV({ ...v, item: e.target.value })}>
              <option value="">—</option>
              {(data?.data.products ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label><span>Message</span><textarea rows={2} value={v.message} onChange={(e) => setV({ ...v, message: e.target.value })} /></label>
          {/* Honeypot: hidden from people, filled in by bots. */}
          <input type="text" name="website" tabIndex={-1} autoComplete="off" value={v.website} onChange={(e) => setV({ ...v, website: e.target.value })}
            style={{ position: 'absolute', left: '-9999px', width: 1, height: 1 }} aria-hidden="true" />
          <div className="form-foot"><button className="primary big" disabled={busy}>{busy ? 'Sending…' : 'Send enquiry'}</button><ErrorBox error={err} /></div>
        </form>
      </div>
    </div>
  );
}
