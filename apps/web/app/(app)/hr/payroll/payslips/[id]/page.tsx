'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { PayslipDocument } from '@/components/payroll';
import { Loading, Page, inr } from '@/components/ui';
import { post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/** One payslip, to print or to send to the person as a link they open on their phone. */
export default function PayslipPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const { data, loading, error } = useGet<{ data: any }>(`/payroll/payslips/${id}`);
  const [problem, setProblem] = useState<string | null>(null);
  const slip = data?.data;
  if (!slip) return <Page title="Payslip"><Loading loading={loading} error={error} /></Page>;

  async function send() {
    // The new tab is opened in the click itself (browsers block one opened later), then pointed at WhatsApp.
    const tab = window.open('', '_blank');
    setProblem(null);
    try {
      const res = await post(`/payroll/payslips/${id}/share`);
      const text = `Hi ${String(res.data.name).split(' ')[0]}, your payslip for ${res.data.month_name} is ready. Net pay ₹${inr(res.data.net_pay)}.\n${window.location.origin}${res.data.path}`;
      if (tab) tab.location.href = `https://wa.me/${String(res.data.phone ?? '').replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
    } catch (e) {
      tab?.close();
      setProblem((e as Error).message);
    }
  }

  return (
    <Page title={`Payslip: ${slip.employee_name}, ${slip.month_name}`} actions={
      <>
        <button type="button" className="primary" onClick={() => window.print()}>Print / Save PDF</button>
        {can('payroll:manage') && slip.run_status !== 'draft' ? <button type="button" onClick={send}>Send on WhatsApp</button> : null}
      </>
    }>
      <p className="no-print"><Link href={`/hr/payroll/${slip.runId ?? slip.run_id}`}>← Salary for {slip.month_name}</Link></p>
      {problem ? <p className="error no-print">{problem}</p> : null}
      <PayslipDocument slip={slip} />
    </Page>
  );
}
