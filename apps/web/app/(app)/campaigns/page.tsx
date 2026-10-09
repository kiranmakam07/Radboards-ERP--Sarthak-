'use client';

import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { ActionButton, Badge, Card, Form, Loading, Page, Table, Toggle } from '@/components/ui';
import { patch, post, useGet } from '@/lib/api';

/**
 * A link per campaign (PRD 7.1). Print it as a QR code on pamphlets, or put it behind the
 * website form: enquiries arrive as leads with the source already filled in.
 */
export default function CampaignsPage() {
  const { data, loading, error, reload } = useGet<{ data: any[] }>('/masters/campaigns');
  const sources = useGet<{ data: any[] }>('/masters/lead-sources');
  const [qrFor, setQrFor] = useState<string | null>(null);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const chosen = data?.data.find((c) => c.id === qrFor);
  return (
    <Page title="Campaign links">
      <Toggle label="+ New campaign link">
        <Form submit="Create link"
          fields={[
            { name: 'name', label: 'Campaign name', required: true, placeholder: 'e.g. Diwali pamphlets batch 2' },
            { name: 'source_id', label: 'Lead source', type: 'select', required: true, options: (sources.data?.data ?? []).filter((s) => s.active).map((s) => ({ value: s.id, label: s.name })) },
          ]}
          onSubmit={(v) => post('/masters/campaigns', v)} onDone={reload} />
      </Toggle>
      <Loading loading={loading} error={error} />
      {chosen ? <QrCard name={chosen.name} url={`${origin}/enquiry/${chosen.token}`} onClose={() => setQrFor(null)} /> : null}
      {/* While a QR code is open, printing gives just the code, not the list behind it. */}
      <div className={chosen ? 'no-print' : undefined}>
        <Table rows={data?.data} empty="No campaign links yet." columns={[
          { key: 'name', title: 'Campaign' },
          { key: 'source_name', title: 'Source' },
          { key: 'link', title: 'Public enquiry link', render: (r) => <a href={`/enquiry/${r.token}`} target="_blank" rel="noreferrer">{origin}/enquiry/{r.token}</a> },
          { key: 'active', title: 'Status', render: (r) => <Badge value={r.active ? 'approved' : 'closed'} /> },
          { key: 'x', title: '', render: (r) => (
            <>
              <button type="button" onClick={() => setQrFor(qrFor === r.id ? null : r.id)}>QR code</button>{' '}
              <ActionButton onClick={() => patch(`/masters/campaigns/${r.id}`, { active: !r.active })} onDone={reload}>{r.active ? 'Switch off' : 'Switch on'}</ActionButton>
            </>
          ) },
        ]} />
      </div>
    </Page>
  );
}

/** The campaign's enquiry link as a QR code, sized to print on a pamphlet or a counter card. */
function QrCard({ name, url, onClose }: { name: string; url: string; onClose: () => void }) {
  const [image, setImage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // Medium error correction: still scans with a smudge or a fold across it.
    QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 640 })
      .then((src) => { if (live) setImage(src); })
      .catch((e: Error) => { if (live) setProblem(e.message); });
    return () => { live = false; };
  }, [url]);
  return (
    <Card title={`QR code: ${name}`} actions={
      <>
        {image ? <a className="button" href={image} download={`${name.replace(/[^\w-]+/g, '-')}-qr.png`}>Save image</a> : null}
        <button type="button" className="primary" onClick={() => window.print()}>Print</button>
        <button type="button" onClick={onClose}>× Close</button>
      </>
    }>
      <div style={{ textAlign: 'center' }}>
        {problem ? <p className="error">{problem}</p> : null}
        {image ? <img src={image} alt={`QR code that opens the enquiry form for ${name}`} width={280} height={280} /> : <p className="muted">Drawing…</p>}
        <p style={{ margin: '6px 0 0' }}><strong>Scan to enquire</strong></p>
        <p className="muted small" style={{ overflowWrap: 'anywhere' }}>{url}</p>
      </div>
    </Card>
  );
}
