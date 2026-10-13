'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { employeeFields } from '@/components/masters';
import { PayDetails } from '@/components/payroll';
import { Badge, Card, Form, KV, Loading, Notice, Page, Table, date, inr, label, num } from '@/components/ui';
import { patch, post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

export default function EmployeePage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const { data, loading, error, reload } = useGet<{ data: any }>(`/hr/employees/${id}`);
  const users = useGet<{ data: any[] }>('/masters/users-lite');
  const [notice, setNotice] = useState<string | null>(null);
  const [pay, setPay] = useState(false);
  const e = data?.data;
  if (!e) return <Page title="Employee"><Loading loading={loading} error={error} /></Page>;
  // The record itself is a master; recording that someone has left is HR's own work.
  const manage = can('employees:manage');
  const canExit = manage || can('hr:write');

  return (
    <Page title={`${e.employee_no} · ${e.name}`} actions={<a className="button" href={`tel:${e.phone}`}>Call</a>}>
      <Notice>{notice}</Notice>
      <Card>
        <KV rows={[
          ['Status', <><Badge value={e.status} />{e.left_on ? ` on ${date(e.left_on)}${e.left_reason ? ` (${e.left_reason})` : ''}` : ''}</>],
          ['Department', e.department], ['Designation', e.designation], ['Type', label(e.employment_type)],
          ['Phone', e.phone], ['Email', e.email],
          ['Joined', date(e.join_date)],
          ['Salary', e.monthly_salary ? `₹${inr(e.monthly_salary)} per month` : null],
          ['Taken off the salary', [e.pf_applicable ? 'PF' : null, e.esic_applicable ? 'ESIC' : null, Number(e.pt_monthly) ? `PT ₹${num(e.pt_monthly)}` : null, Number(e.tds_monthly) ? `TDS ₹${num(e.tds_monthly)}` : null].filter(Boolean).join(', ') || null],
          ['Bank account', e.bank_account_no ? `${e.bank_account_no} · ${e.bank_ifsc ?? ''}` : null],
          ['Leave days a year', e.annual_leave_days !== null ? `${Number(e.annual_leave_days)} (own figure)` : null],
          ['Sign-in', e.user_name ? `${e.user_name} (${e.user_role})${e.user_active ? '' : ', switched off'}` : null],
          ['Application', e.applicant_id ? <Link href={`/hr/applicants/${e.applicant_id}`}>{e.applicant_no}</Link> : null],
          ['Notes', e.notes],
        ]} />
      </Card>

      {manage && pay ? <PayDetails key={e.updated_at} person={e} onDone={() => { setPay(false); reload(); }} /> : null}
      {(manage || canExit) && (
        <div className="grid">
          {manage && (
          <Card title="Edit" actions={<button type="button" onClick={() => setPay(true)}>Salary, deductions and bank</button>}>
            {/* Remounted after each save so the form shows what is now on record. */}
            <Form key={e.updated_at} submit="Save"
              initial={{
                name: e.name, phone: e.phone, email: e.email ?? '', department: e.department, designation: e.designation,
                employment_type: e.employment_type, join_date: e.join_date, monthly_salary: e.monthly_salary ?? '', user_id: e.user_id ?? '', notes: e.notes ?? '',
                annual_leave_days: e.annual_leave_days ?? '',
              }}
              fields={[
                ...employeeFields(users.data?.data ?? []).map((x) => (x.name === 'user_id' ? { ...x, help: undefined } : x)),
                { name: 'annual_leave_days', label: 'Leave days a year', type: 'number', step: '0.5', help: 'Blank = the company figure' },
                { name: 'notes', label: 'Notes', type: 'textarea' },
              ]}
              onSubmit={(v) => patch(`/hr/employees/${id}`, v)}
              onDone={reload} />
          </Card>
          )}

          {canExit && e.status === 'active' && (
            <Card title="Record that they have left">
              <Form submit="Record exit"
                fields={[
                  { name: 'left_on', label: 'Last working day', type: 'date', required: true },
                  { name: 'reason', label: 'Reason', type: 'textarea' },
                ]}
                onSubmit={(v) => post(`/hr/employees/${id}/exit`, v)}
                onDone={(res) => {
                  setNotice(res.sign_in_still_active ? 'Exit recorded. This person still has a working sign-in: ask an admin to switch it off under Users.' : 'Exit recorded.');
                  reload();
                }} />
            </Card>
          )}
        </div>
      )}
      {!manage ? <p className="muted small no-print">This record is part of the masters. Ask an admin to change it.</p> : null}

      <Card title="Attendance, last 31 marked days" actions={<Link href="/hr/attendance">Open the register</Link>}>
        <Table rows={e.recent_attendance} empty="Nothing marked yet." columns={[
          { key: 'date', title: 'Day', render: (r) => date(r.date) },
          { key: 'status', title: 'Status', render: (r) => <Badge value={r.status} /> },
          { key: 'check_in', title: 'In' }, { key: 'check_out', title: 'Out' },
          { key: 'note', title: 'Note' },
        ]} />
      </Card>
    </Page>
  );
}
