'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PayslipDocument } from '@/components/payroll';
import { Loading, Page } from '@/components/ui';
import { useGet } from '@/lib/api';

/** A person's own payslip, opened from "My work". */
export default function MyPayslipPage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error } = useGet<{ data: any }>(`/payroll/my-payslips/${id}`);
  const slip = data?.data;
  if (!slip) return <Page title="My payslip"><Loading loading={loading} error={error} /></Page>;
  return (
    <Page title={`My payslip, ${slip.month_name}`} actions={<button type="button" className="primary" onClick={() => window.print()}>Print / Save PDF</button>}>
      <p className="no-print"><Link href="/my-work">← My work</Link></p>
      <PayslipDocument slip={slip} />
    </Page>
  );
}
