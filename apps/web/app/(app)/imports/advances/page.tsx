'use client';

import { CsvLink, Loading, Page, Table, inr } from '@/components/ui';
import { useGet } from '@/lib/api';

/** Money paid out to suppliers and not yet set against a bill, by how long ago it was paid. */
export default function SupplierAdvancesPage() {
  const { data, loading, error } = useGet<{ data: any[] }>('/imports/advances');
  return (
    <Page title="Advances to suppliers" actions={<CsvLink href="/imports/advances" />}>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} rowHref={(r) => `/parties/${r.party_id}`} empty="No advances waiting to be set against a bill." columns={[
        { key: 'supplier', title: 'Supplier' },
        { key: 'days_0_30', title: '0 to 30 days ₹', align: 'right', render: (r) => inr(r.days_0_30) },
        { key: 'days_31_90', title: '31 to 90 days ₹', align: 'right', render: (r) => inr(r.days_31_90) },
        { key: 'over_90', title: 'Over 90 days ₹', align: 'right', render: (r) => inr(r.over_90) },
        { key: 'total', title: 'Total ₹', align: 'right', render: (r) => <strong>{inr(r.total)}</strong> },
      ]} />
      <p className="muted small" style={{ marginTop: 8 }}>An advance is set against the supplier&apos;s bill when it comes, from the payment&apos;s own page.</p>
    </Page>
  );
}
