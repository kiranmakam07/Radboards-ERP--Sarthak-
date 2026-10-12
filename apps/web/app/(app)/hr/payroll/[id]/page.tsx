'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { istDate } from '@radcore/shared';
import { ActionButton, Badge, Card, ErrorBox, Form, Loading, Notice, Page, Stat, Table, date, inr, num } from '@/components/ui';
import { api, patch, post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/** A bonus or arrears to add, or a fine to take off, for one person this month. */
function Adjust({ slip, onDone }: { slip: any; onDone: () => void }) {
  return (
    <div className="toggle-body" style={{ marginBottom: 12 }}>
      <div className="card-head"><h2>Add to or take off {slip.employee_name}&apos;s pay this month</h2><button type="button" onClick={onDone}>× Close</button></div>
      <Form submit="Save" key={slip.id}
        initial={{ other_earning: Number(slip.other_earning) ? slip.other_earning : '', other_deduction: Number(slip.other_deduction) ? slip.other_deduction : '', note: slip.note ?? '' }}
        fields={[
          { name: 'other_earning', label: 'Add ₹ (bonus, arrears)', type: 'number', step: '0.01' },
          { name: 'other_deduction', label: 'Take off ₹ (fine, damage)', type: 'number', step: '0.01' },
          { name: 'note', label: 'What for (printed on the payslip)' },
        ]}
        onSubmit={(v) => patch(`/payroll/payslips/${slip.id}`, { other_earning: v.other_earning || 0, other_deduction: v.other_deduction || 0, note: v.note || null })}
        onDone={onDone} />
    </div>
  );
}

/** One month's salary: everyone's payslip, the totals, and the steps from draft to paid. */
export default function PayrollRunPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const can = useCan();
  const manage = can('payroll:manage');
  const { data, loading, error, reload } = useGet<{ data: any }>(`/payroll/runs/${id}`);
  const money = useGet<{ data: any[] }>(manage ? '/accounting/money-accounts' : null);
  const [adjusting, setAdjusting] = useState<any | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const run = data?.data;
  if (!run) return <Page title="Salary"><Loading loading={loading} error={error} /></Page>;
  const t = run.totals;
  const draft = run.status === 'draft';

  async function approve(evenIfUnmarked: boolean) {
    setProblem(null);
    try {
      await post(`/payroll/runs/${id}/approve`, { even_if_unmarked: evenIfUnmarked });
      setNotice('Approved. The salary is in the books and the payslips can be sent.');
      reload();
    } catch (e) {
      const message = (e as Error).message;
      // Unmarked days are the one thing a person may decide to go ahead with.
      if (!evenIfUnmarked && /nobody marked/.test(message) && window.confirm(`${message}\n\nApprove as it is?`)) return approve(true);
      setProblem(message);
    }
  }

  return (
    <Page title={`Salary for ${run.month_name}`} actions={
      <>
        <Badge value={run.status} />
        {!draft ? <a className="button" href={`/api/payroll/runs/${id}/bank-file?format=xlsx`}>List for the bank (Excel)</a> : null}
        {manage && draft ? <ActionButton onClick={() => post(`/payroll/runs/${id}/recalculate`)} onDone={() => { setNotice('Worked out again from the register.'); reload(); }}>Work out again</ActionButton> : null}
        {manage && draft ? <button type="button" className="primary" onClick={() => approve(false)}>Approve</button> : null}
        {manage && run.status === 'approved' ? <ActionButton confirm="Take this month back to draft to correct it? The entry in the books is reversed." onClick={() => post(`/payroll/runs/${id}/reopen`)} onDone={reload}>Reopen</ActionButton> : null}
        {manage && draft ? <ActionButton confirm="Remove this draft?" onClick={() => api(`/payroll/runs/${id}`, { method: 'DELETE' })} onDone={() => router.push('/hr/payroll')}>Remove</ActionButton> : null}
      </>
    }>
      <p className="no-print"><Link href="/hr/payroll">← Payroll</Link>{run.booked_on ? <span className="muted"> · in the books on {date(run.booked_on)}</span> : null}
        {run.paid_on ? <span className="muted"> · paid on {date(run.paid_on)}{run.payment_reference ? ` (${run.payment_reference})` : ''}</span> : null}</p>
      <Notice>{notice}</Notice>
      <ErrorBox error={problem} />
      {t.not_marked > 0 && draft ? (
        <p className="error">{t.not_marked} working {t.not_marked === 1 ? 'day is' : 'days are'} not marked in the <Link href="/hr/attendance">attendance register</Link>. They are not paid. Complete the register, then press “Work out again”.</p>
      ) : null}
      {run.no_salary.length > 0 ? <p className="muted small">Left out because no salary is set: {run.no_salary.map((e: any) => e.name).join(', ')}.</p> : null}

      <div className="stats">
        <Stat label="Earned" value={`₹${inr(t.earnings)}`} hint={`${run.payslips.length} ${run.payslips.length === 1 ? 'person' : 'people'}`} />
        <Stat label="Taken off" value={`₹${inr(Number(t.pf) + Number(t.esic) + Number(t.pt) + Number(t.tds) + Number(t.advances) + Number(t.other_deductions))}`}
          hint={[Number(t.pf) ? `PF ${inr(t.pf)}` : null, Number(t.esic) ? `ESIC ${inr(t.esic)}` : null, Number(t.pt) ? `PT ${inr(t.pt)}` : null, Number(t.tds) ? `TDS ${inr(t.tds)}` : null, Number(t.advances) ? `advances ${inr(t.advances)}` : null].filter(Boolean).join(' · ') || undefined} />
        <Stat label="Net pay" value={`₹${inr(t.net_pay)}`} hint="goes to the staff" />
        <Stat label="Cost to the company" value={`₹${inr(t.cost_to_company)}`} hint={Number(t.employer_pf) || Number(t.employer_esic) ? `includes our PF ${inr(t.employer_pf)} and ESIC ${inr(t.employer_esic)}` : undefined} />
      </div>

      {manage && run.status === 'approved' && money.data ? (
        <Card title="Pay these salaries">
          <Form submit={`Record ₹${inr(t.net_pay)} as paid`} initial={{ paid_on: istDate(), paid_from_account_id: money.data.data.find((a) => a.subtype === 'bank')?.id ?? '' }}
            fields={[
              { name: 'paid_from_account_id', label: 'Paid from', type: 'select', required: true, options: money.data.data.map((a) => ({ value: a.id, label: `${a.code} ${a.name}` })) },
              { name: 'paid_on', label: 'Paid on', type: 'date', required: true },
              { name: 'reference', label: 'Reference', placeholder: 'Bank batch or UTR number' },
            ]}
            onSubmit={(v) => post(`/payroll/runs/${id}/pay`, v)} onDone={() => { setNotice('Recorded as paid.'); reload(); }} />
        </Card>
      ) : null}

      {adjusting && <Adjust slip={adjusting} onDone={() => { setAdjusting(null); reload(); }} />}
      <Card title="Payslips">
        <Table rows={run.payslips} empty="Nobody has a salary set." rowHref={(s) => `/hr/payroll/payslips/${s.id}`} columns={[
          { key: 'employee_name', title: 'Employee' },
          { key: 'paid_days', title: 'Paid days', align: 'right', render: (s) => <>{num(s.paid_days)}<span className="muted small"> / {s.days_in_month}</span>{s.not_marked ? <span className="error small"> · {s.not_marked} not marked</span> : null}</> },
          { key: 'monthly_salary', title: 'Salary', align: 'right', render: (s) => inr(s.monthly_salary) },
          { key: 'gross_earned', title: 'Earned', align: 'right', render: (s) => <>{inr(s.gross_earned)}{Number(s.other_earning) ? <span className="muted small"> + {inr(s.other_earning)}</span> : null}</> },
          { key: 'deductions', title: 'Taken off', align: 'right', render: (s) => inr(Number(s.pf_employee) + Number(s.esic_employee) + Number(s.pt) + Number(s.tds) + Number(s.advance_recovery) + Number(s.other_deduction)) },
          { key: 'net_pay', title: 'Net pay', align: 'right', render: (s) => <strong>{inr(s.net_pay)}</strong> },
          { key: 'note', title: 'Note', render: (s) => <span style={{ whiteSpace: 'normal' }}>{s.note}</span> },
          { key: 'x', title: '', render: (s) => (manage && draft ? <button type="button" onClick={() => setAdjusting(s)}>Add or take off</button> : null) },
        ]} />
      </Card>
    </Page>
  );
}
