'use client';

import { useState } from 'react';
import { istDate } from '@radcore/shared';
import { ActionButton, Badge, CsvLink, Loading, Page, Table, dateTime, label } from '@/components/ui';
import { post, qs, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/** Test rides from a day on: who, on which demo unit, when, and how it went. Booked from the lead's page. */
export default function TestRidesPage() {
  const can = useCan();
  const [from, setFrom] = useState(istDate());
  const path = `/pipeline/test-rides${qs({ from })}`;
  const { data, loading, error, reload } = useGet<{ data: any[] }>(path);
  return (
    <Page title="Test rides" actions={<CsvLink href={path} />}>
      <div className="filters">
        <label className="inline">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value || istDate())} /></label>
      </div>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} rowHref={(r) => `/leads/${r.lead_id}`} empty="No test rides from this day. A test ride is booked from the lead's page." columns={[
        { key: 'slot_at', title: 'When', render: (r) => `${dateTime(r.slot_at)} · ${r.minutes} min` },
        { key: 'lead_name', title: 'Lead', render: (r) => <>{r.lead_name}<div className="muted small">{r.lead_phone}</div></> },
        { key: 'serial_no', title: 'Demo unit', render: (r) => `${r.item_name} ${r.serial_no}` },
        { key: 'staff_name', title: 'With' },
        { key: 'outcome', title: 'How it went', render: (r) => <>{label(r.outcome)}{r.notes ? <div className="muted small">{r.notes}</div> : null}</> },
        { key: 'lead_stage', title: 'Lead now', render: (r) => <Badge value={r.lead_stage} /> },
        { key: 'x', title: '', render: (r) => (can('leads:write') && r.outcome === 'booked' ? (
          <span className="actions">
            <ActionButton onClick={() => post(`/pipeline/test-rides/${r.id}/outcome`, { outcome: 'done' })} onDone={reload}>Done</ActionButton>
            <ActionButton onClick={() => post(`/pipeline/test-rides/${r.id}/outcome`, { outcome: 'no_show' })} onDone={reload}>No show</ActionButton>
          </span>
        ) : null) },
      ]} />
    </Page>
  );
}
