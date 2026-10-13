'use client';

import { useState } from 'react';
import { istDate, monthName } from '@radcore/shared';
import { PayDetails } from '@/components/payroll';
import { ActionButton, Badge, Card, Form, Loading, Page, Table, Toggle, date, inr, num } from '@/components/ui';
import { post, put, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/** The month before this one: the one whose salary is usually due. */
const lastMonth = () => {
  const [y, m] = istDate().slice(0, 7).split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

function Rules({ onDone }: { onDone: () => void }) {
  const { data, reload } = useGet<{ data: any }>('/payroll/rules');
  if (!data) return null;
  return (
    <>
      <p className="muted small">
        These are the figures in general use. Change them only if your registration or the law says otherwise; whether PF and ESIC apply to a
        person at all is set on that person.
      </p>
      <Form submit="Save the rules" initial={data.data}
        fields={[
          { name: 'basic_pct', label: 'Basic, as % of salary', type: 'number', step: '0.01', required: true },
          { name: 'pf_rate', label: 'PF, % of Basic', type: 'number', step: '0.01', required: true },
          { name: 'pf_wage_ceiling', label: 'PF is charged on Basic up to ₹', type: 'number', required: true },
          { name: 'esic_employee_rate', label: 'ESIC from the employee, %', type: 'number', step: '0.01', required: true },
          { name: 'esic_employer_rate', label: 'ESIC from the company, %', type: 'number', step: '0.01', required: true },
          { name: 'esic_gross_limit', label: 'ESIC applies up to a monthly salary of ₹', type: 'number', required: true },
        ]}
        onSubmit={(v) => put('/payroll/rules', v)} onDone={() => { reload(); onDone(); }} />
    </>
  );
}

/**
 * Payroll: the month's salary worked out from the attendance register, the advances people have
 * taken, and what each person is paid.
 */
export default function PayrollPage() {
  const can = useCan();
  const manage = can('payroll:manage');
  const runs = useGet<{ data: any[] }>('/payroll/runs');
  const staff = useGet<{ data: any[] }>('/payroll/staff');
  const advances = useGet<{ data: any[] }>('/payroll/advances');
  const money = useGet<{ data: any[] }>(manage ? '/accounting/money-accounts' : null);
  const [editing, setEditing] = useState<any | null>(null);
  const started = (runs.data?.data ?? []).map((r) => r.month);
  const noSalary = (staff.data?.data ?? []).filter((e) => !Number(e.monthly_salary)).length;

  return (
    <Page title="Payroll">
      <p className="muted">
        Each month&apos;s salary is worked out from the attendance register: days worked, paid leave, weekly offs and holidays are paid; absent days
        and working days nobody marked are not. Approving a month puts it in the books; paying it sends the net salaries out of the bank.
      </p>

      <Card title="Salary by month">
        {manage && (
          <Toggle label="+ Start a month">
            <Form submit="Work out the salaries" initial={{ month: started.includes(lastMonth()) ? istDate().slice(0, 7) : lastMonth() }}
              fields={[{ name: 'month', label: 'Month (YYYY-MM)', required: true, placeholder: '2026-10' }]}
              onSubmit={(v) => post('/payroll/runs', v)}
              onDone={(r) => { window.location.href = `/hr/payroll/${r.data.id}`; }} />
          </Toggle>
        )}
        <Loading loading={runs.loading} error={runs.error} />
        <Table rows={runs.data?.data} empty="No month has been started yet." rowHref={(r) => `/hr/payroll/${r.id}`} columns={[
          { key: 'month', title: 'Month', render: (r) => monthName(r.month) },
          { key: 'status', title: 'Status', render: (r) => <Badge value={r.status} /> },
          { key: 'people', title: 'People', align: 'right' },
          { key: 'earnings', title: 'Earned', align: 'right', render: (r) => inr(r.earnings) },
          { key: 'net_pay', title: 'Net pay', align: 'right', render: (r) => <strong>{inr(r.net_pay)}</strong> },
          { key: 'not_marked', title: 'Days not marked', align: 'right', render: (r) => (r.not_marked ? <span className="error small">{r.not_marked}</span> : 0) },
          { key: 'paid_on', title: 'Paid on', render: (r) => date(r.paid_on) },
        ]} />
      </Card>

      {editing && <PayDetails key={editing.id} person={editing} onDone={() => { setEditing(null); staff.reload(); }} />}
      <Card title="Who is paid what">
        {!can('employees:manage') ? <p className="muted small">A person&apos;s salary, deductions and bank account are part of the employee master, and are changed in Masters.</p> : null}
        {noSalary > 0 ? <p className="muted small">{noSalary} {noSalary === 1 ? 'person has' : 'people have'} no salary set, and will be left out of the month&apos;s salary until one is.</p> : null}
        <Loading loading={staff.loading} error={staff.error} />
        <Table rows={staff.data?.data} empty="Nobody is on the rolls." columns={[
          { key: 'name', title: 'Employee', render: (e) => <>{e.name} <span className="muted small">{e.employee_no}</span></> },
          { key: 'department', title: 'Department' },
          { key: 'monthly_salary', title: 'Monthly salary', align: 'right', render: (e) => (Number(e.monthly_salary) ? inr(e.monthly_salary) : <span className="error small">not set</span>) },
          { key: 'deductions', title: 'Taken off', render: (e) => [e.pf_applicable ? 'PF' : null, e.esic_applicable ? 'ESIC' : null, Number(e.pt_monthly) ? `PT ₹${num(e.pt_monthly)}` : null, Number(e.tds_monthly) ? `TDS ₹${num(e.tds_monthly)}` : null].filter(Boolean).join(', ') || <span className="muted">nothing</span> },
          { key: 'bank', title: 'Bank account', render: (e) => (e.bank_account_no ? <>{e.bank_account_no}<span className="muted small"> · {e.bank_ifsc}</span></> : <span className="muted">not given</span>) },
          { key: 'advance_outstanding', title: 'Advance owed', align: 'right', render: (e) => (Number(e.advance_outstanding) ? inr(e.advance_outstanding) : '') },
          { key: 'x', title: '', render: (e) => (can('employees:manage') ? <button type="button" onClick={() => setEditing(e)}>Change</button> : null) },
        ]} />
      </Card>

      <Card title="Advances">
        {manage && money.data && (
          <Toggle label="+ Give an advance">
            <Form submit="Record the advance" initial={{ given_on: istDate(), paid_from_account_id: money.data.data.find((a) => a.subtype === 'cash')?.id ?? '' }}
              fields={[
                { name: 'employee_id', label: 'To', type: 'select', required: true, options: (staff.data?.data ?? []).map((e) => ({ value: e.id, label: `${e.name} (${e.employee_no})` })) },
                { name: 'amount', label: 'Amount ₹', type: 'number', step: '0.01', required: true },
                { name: 'monthly_recovery', label: 'Taken back each month ₹', type: 'number', step: '0.01', required: true },
                { name: 'given_on', label: 'Given on', type: 'date', required: true },
                { name: 'paid_from_account_id', label: 'Paid from', type: 'select', required: true, options: money.data.data.map((a) => ({ value: a.id, label: `${a.code} ${a.name}` })) },
                { name: 'note', label: 'What for' },
              ]}
              onSubmit={(v) => post('/payroll/advances', v)} onDone={() => { advances.reload(); staff.reload(); }} />
          </Toggle>
        )}
        <Table rows={advances.data?.data} empty="No advances have been given." columns={[
          { key: 'name', title: 'Employee', render: (a) => <>{a.name} <span className="muted small">{a.employee_no}</span></> },
          { key: 'given_on', title: 'Given', render: (a) => date(a.given_on) },
          { key: 'amount', title: 'Amount', align: 'right', render: (a) => inr(a.amount) },
          { key: 'monthly_recovery', title: 'Back each month', align: 'right', render: (a) => inr(a.monthly_recovery) },
          { key: 'recovered', title: 'Taken back', align: 'right', render: (a) => inr(a.recovered) },
          { key: 'outstanding', title: 'Still owed', align: 'right', render: (a) => (a.cancelled_at ? <span className="badge grey">Cancelled</span> : <strong>{inr(a.outstanding)}</strong>) },
          { key: 'note', title: 'What for', render: (a) => <span style={{ whiteSpace: 'normal' }}>{a.note}</span> },
          { key: 'x', title: '', render: (a) => (manage && !a.cancelled_at && !Number(a.recovered) ? (
            <ActionButton confirm="Cancel this advance? Use this only if it was entered by mistake." onClick={() => post(`/payroll/advances/${a.id}/cancel`)}
              onDone={() => { advances.reload(); staff.reload(); }}>Cancel</ActionButton>
          ) : null) },
        ]} />
      </Card>

      {manage && <Toggle label="Rules the salary is worked out by"><Rules onDone={() => runs.reload()} /></Toggle>}
    </Page>
  );
}
