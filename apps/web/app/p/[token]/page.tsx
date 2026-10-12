'use client';

import { useParams } from 'next/navigation';
import { PayslipDocument } from '@/components/payroll';
import { useGet } from '@/lib/api';

/** A payslip as the person sees it when they open the link sent to them. No sign-in. */
export default function SharedPayslipPage() {
  const { token } = useParams<{ token: string }>();
  const { data, error } = useGet<{ data: any }>(`/public/payslips/${token}`);
  const slip = data?.data;
  if (error) {
    return (
      <div className="center">
        <div className="card"><h1 style={{ marginBottom: 8 }}>This link is not available</h1><p className="muted">Ask whoever sent it to you for a new one.</p></div>
      </div>
    );
  }
  if (!slip) return <div className="center muted">Loading…</div>;
  return (
    <div className="shared">
      <div className="no-print" style={{ textAlign: 'right', marginBottom: 12 }}>
        <button type="button" className="primary" onClick={() => window.print()}>Print / Save PDF</button>
      </div>
      <PayslipDocument slip={slip} />
    </div>
  );
}
