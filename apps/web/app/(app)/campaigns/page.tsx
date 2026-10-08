'use client';

import { ActionButton, Badge, Form, Loading, Page, Table, Toggle } from '@/components/ui';
import { patch, post, useGet } from '@/lib/api';

/**
 * A link per campaign (PRD 7.1). Print it as a QR code on pamphlets, or put it behind the
 * website form: enquiries arrive as leads with the source already filled in.
 */
export default function CampaignsPage() {
  const { data, loading, error, reload } = useGet<{ data: any[] }>('/masters/campaigns');
  const sources = useGet<{ data: any[] }>('/masters/lead-sources');
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
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
      <Table rows={data?.data} empty="No campaign links yet." columns={[
        { key: 'name', title: 'Campaign' },
        { key: 'source_name', title: 'Source' },
        { key: 'link', title: 'Public enquiry link', render: (r) => <a href={`/enquiry/${r.token}`} target="_blank" rel="noreferrer">{origin}/enquiry/{r.token}</a> },
        { key: 'active', title: 'Status', render: (r) => <Badge value={r.active ? 'approved' : 'closed'} /> },
        { key: 'x', title: '', render: (r) => (
          <ActionButton onClick={() => patch(`/masters/campaigns/${r.id}`, { active: !r.active })} onDone={reload}>{r.active ? 'Switch off' : 'Switch on'}</ActionButton>
        ) },
      ]} />
    </Page>
  );
}
