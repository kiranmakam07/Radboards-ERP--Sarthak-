'use client';

import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { post, useGet } from '@/lib/api';

/**
 * What someone sees when they open a file we sent them. No login. Telling the server "this is on
 * a screen now" is what marks the file as opened: a link preview fetched by a chat app does not
 * run this page, so it does not count.
 */
export default function SharedFilePage() {
  const { token } = useParams<{ token: string }>();
  const { data, error } = useGet<{ data: { title: string; mime: string; from: string; phone: string | null } }>(`/public/shares/${token}`);
  const d = data?.data;
  const file = `/api/public/shares/${token}/file`;

  useEffect(() => {
    if (d) void post(`/public/shares/${token}/open`).catch(() => null);
  }, [d, token]);

  if (error) {
    return (
      <div className="center">
        <div className="card"><h1 style={{ marginBottom: 8 }}>This link is no longer available</h1><p className="muted">Ask whoever sent it to you for a new one.</p></div>
      </div>
    );
  }
  if (!d) return <div className="center muted">Loading…</div>;
  return (
    <div className="shared">
      <header>
        <div className="muted small">{d.from} sent you</div>
        <h1>{d.title}</h1>
      </header>
      {d.mime.startsWith('image/')
        ? <img src={file} alt={d.title} />
        : <iframe src={file} title={d.title} />}
      <p><a className="button primary" href={file} target="_blank" rel="noreferrer">Open the file</a></p>
      {d.phone ? <p className="muted small">Questions? Call {d.from} on {d.phone}.</p> : null}
    </div>
  );
}
