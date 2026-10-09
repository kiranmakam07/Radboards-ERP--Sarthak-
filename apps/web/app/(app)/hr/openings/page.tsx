'use client';

import Link from 'next/link';
import { ActionButton, Badge, Form, Loading, Page, Table, Toggle, date } from '@/components/ui';
import { patch, post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

export default function OpeningsPage() {
  const can = useCan();
  const { data, loading, error, reload } = useGet<{ data: any[] }>('/hr/openings');
  const write = can('hr:write');

  /** Closing asks first what to do with the people still in the running. */
  async function close(o: any) {
    if (o.in_progress > 0) {
      if (!window.confirm(`${o.in_progress} applicant(s) are still in progress. Close the opening and reject them as "position filled"?`)) return null;
      return patch(`/hr/openings/${o.id}`, { status: 'closed', reject_open: true });
    }
    return patch(`/hr/openings/${o.id}`, { status: 'closed' });
  }

  return (
    <Page title="Openings">
      {write && (
        <Toggle label="+ New opening">
          <Form submit="Open position"
            initial={{ positions: 1 }}
            fields={[
              { name: 'title', label: 'Job title', required: true },
              { name: 'department', label: 'Department', required: true },
              { name: 'positions', label: 'How many people', type: 'number', step: '1', required: true },
              { name: 'description', label: 'What the job needs', type: 'textarea' },
            ]}
            onSubmit={(v) => post('/hr/openings', v)}
            onDone={reload} />
        </Toggle>
      )}
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} empty="No openings yet." columns={[
        { key: 'title', title: 'Job', render: (r) => <Link href={`/hr/applicants?opening_id=${r.id}`}>{r.title}</Link> },
        { key: 'department', title: 'Department' },
        { key: 'status', title: 'Status', render: (r) => <Badge value={r.status} /> },
        { key: 'hired', title: 'Filled', align: 'right', render: (r) => `${r.hired} of ${r.positions}` },
        { key: 'in_progress', title: 'In progress', align: 'right' },
        { key: 'applicants', title: 'Applicants', align: 'right' },
        { key: 'opened_on', title: 'Opened', render: (r) => date(r.opened_on) },
        { key: 'closed_on', title: 'Closed', render: (r) => date(r.closed_on) },
        { key: 'actions', title: '', render: (r) => (!write ? null : r.status === 'open' ? (
          <>
            <ActionButton onClick={() => patch(`/hr/openings/${r.id}`, { status: 'on_hold' })} onDone={reload}>Put on hold</ActionButton>{' '}
            <ActionButton onClick={() => close(r)} onDone={(done) => done && reload()}>Close</ActionButton>
          </>
        ) : (
          <ActionButton onClick={() => patch(`/hr/openings/${r.id}`, { status: 'open' })} onDone={reload}>Reopen</ActionButton>
        )) },
      ]} />
    </Page>
  );
}
