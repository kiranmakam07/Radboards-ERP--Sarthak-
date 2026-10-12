'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ATTENDANCE_STATUSES, istDate, type AttendanceStatus } from '@radcore/shared';
import { AttendanceRules, LeaveRequests, PlaceNote } from '@/components/hr';
import { Card, ErrorBox, Form, Loading, Notice, Page, Table, label, num } from '@/components/ui';
import { ApiError, api, post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

type Row = { status: AttendanceStatus | ''; check_in: string; check_out: string; note: string };
const worked = (s: string) => s === 'present' || s === 'half_day';

export default function AttendancePage() {
  const can = useCan();
  const write = can('hr:write');
  const today = istDate();
  const [day, setDay] = useState(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const register = useGet<{ data: any[]; rules?: any }>(`/hr/attendance?date=${day}`);
  const summary = useGet<{ data: any[] }>(`/hr/attendance/summary?month=${month}`);
  const leave = useGet<{ data: any[]; fy: string; annual_leave_days: number }>('/hr/leave-balances');
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problems, setProblems] = useState<{ row: number; message: string }[]>([]);

  // What is on record for the chosen day becomes the starting point for editing.
  useEffect(() => {
    const next: Record<string, Row> = {};
    for (const e of register.data?.data ?? []) {
      next[e.employee_id] = { status: e.status ?? '', check_in: e.check_in ?? '', check_out: e.check_out ?? '', note: e.note ?? '' };
    }
    setRows(next);
  }, [register.data]);

  const staff = register.data?.data ?? [];
  const set = (id: string, change: Partial<Row>) => setRows((r) => ({ ...r, [id]: { ...r[id]!, ...change } }));
  const fillBlanks = (status: AttendanceStatus) =>
    setRows((r) => Object.fromEntries(Object.entries(r).map(([id, row]) => [id, row.status === '' ? { ...row, status } : row])));
  const marked = Object.values(rows).filter((r) => r.status !== '').length;

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const entries = Object.entries(rows).filter(([, r]) => r.status !== '').map(([employee_id, r]) => ({
        employee_id, status: r.status, check_in: worked(r.status) ? r.check_in : '', check_out: worked(r.status) ? r.check_out : '', note: r.note,
      }));
      const res = await api('/hr/attendance', { method: 'PUT', body: { date: day, entries } });
      setNotice(`Saved attendance for ${res.data.marked} people.`);
      register.reload();
      summary.reload();
      leave.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setNotice(null);
    setProblems([]);
    try {
      const res = await post('/hr/attendance/import', { csv: await file.text() });
      setNotice(`Imported ${res.data.saved} attendance entries over ${res.data.days} day(s).`);
      register.reload();
      summary.reload();
    } catch (e) {
      setError((e as Error).message);
      const details = (e as ApiError).details as { errors?: { row: number; message: string }[] } | undefined;
      setProblems(details?.errors ?? []);
    }
  }

  return (
    <Page title="Attendance">
      <Notice>{notice}</Notice>
      <ErrorBox error={error} />
      {problems.length > 0 && (
        <Card title="Rows in the file that could not be read">
          <Table rows={problems} columns={[{ key: 'row', title: 'Row' }, { key: 'message', title: 'Problem' }]} />
        </Card>
      )}

      <Card title="Register for the day" actions={
        <label>Day <input type="date" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} style={{ width: 'auto' }} /></label>
      }>
        <Loading loading={register.loading} error={register.error} />
        {staff.length === 0 && !register.loading ? <p className="muted">Nobody was on the rolls on this day. Add people under <Link href="/hr/employees">Employees</Link>.</p> : null}
        {staff.length > 0 && (
          <>
            {write && (
              <div className="filters">
                <span className="muted small">For everyone not marked yet:</span>
                <button type="button" onClick={() => fillBlanks('present')}>Present</button>
                <button type="button" onClick={() => fillBlanks('weekly_off')}>Weekly off</button>
                <button type="button" onClick={() => fillBlanks('holiday')}>Holiday</button>
              </div>
            )}
            <div className="table-wrap stack">
              <table>
                <thead><tr><th>Employee</th><th>Department</th><th>Status</th><th>In</th><th>Out</th><th>Note</th></tr></thead>
                <tbody>
                  {staff.map((e) => {
                    const r = rows[e.employee_id] ?? { status: '', check_in: '', check_out: '', note: '' };
                    return (
                      <tr key={e.employee_id}>
                        <td data-label="Employee"><span><Link href={`/hr/employees/${e.employee_id}`}>{e.name}</Link> <span className="muted small">{e.employee_no}</span>
                          {e.self_marked ? <> <PlaceNote distance={e.in_distance_m} radius={register.data?.rules?.place?.radius_m ?? null} noLocation={e.no_location} /></> : null}
                          {e.late ? <> <span className="badge amber">Late</span></> : null}</span></td>
                        <td data-label="Department">{e.department}</td>
                        <td data-label="Status">
                          <select value={r.status} disabled={!write} aria-label={`Status for ${e.name}`}
                            onChange={(ev) => set(e.employee_id, { status: ev.target.value as Row['status'] })}>
                            <option value="">Not marked</option>
                            {ATTENDANCE_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
                          </select>
                        </td>
                        <td data-label="In"><input type="time" value={r.check_in} disabled={!write || !worked(r.status)} aria-label={`In time for ${e.name}`} onChange={(ev) => set(e.employee_id, { check_in: ev.target.value })} /></td>
                        <td data-label="Out"><input type="time" value={r.check_out} disabled={!write || !worked(r.status)} aria-label={`Out time for ${e.name}`} onChange={(ev) => set(e.employee_id, { check_out: ev.target.value })} /></td>
                        <td data-label="Note"><input value={r.note} disabled={!write} aria-label={`Note for ${e.name}`} onChange={(ev) => set(e.employee_id, { note: ev.target.value })} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {write && (
              <div className="form-foot" style={{ marginTop: 10 }}>
                <button type="button" className="primary" disabled={busy || marked === 0} onClick={save}>{busy ? 'Saving…' : `Save ${marked} of ${staff.length}`}</button>
                <span className="muted small">Saving a day again replaces what was there.</span>
              </div>
            )}
          </>
        )}
      </Card>

      {write && (
        <Card title="Bring in a file from the attendance app">
          <p className="muted small">
            A CSV with a header row and columns for the employee (their number here, or phone), the date and the status
            (Present, Absent, Half day, Leave, Weekly off, Holiday, or P / A / HD / L / WO / H). In and out times are optional.
            If any row cannot be read, nothing is imported and the problem rows are listed.
          </p>
          <input type="file" accept=".csv,text/csv" onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = ''; }} />
        </Card>
      )}

      <LeaveRequests canDecide={write} onChange={() => { register.reload(); summary.reload(); leave.reload(); }} />

      <Card title="The month, by employee" actions={
        <>
          <label>Month <input type="month" value={month} max={today.slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} style={{ width: 'auto' }} /></label>
          <a className="button" href={`/api/hr/attendance/summary?month=${month}&format=xlsx`}>Excel</a>
          <a className="button" href={`/api/hr/attendance/summary?month=${month}&format=csv`}>CSV</a>
        </>
      }>
        <Loading loading={summary.loading} error={summary.error} />
        <Table rows={summary.data?.data} empty="Nobody on the rolls in this month." rowHref={(r) => `/hr/employees/${r.employee_id}`} columns={[
          { key: 'name', title: 'Employee' }, { key: 'department', title: 'Department' },
          { key: 'days_worked', title: 'Days worked', align: 'right', render: (r) => num(r.days_worked) },
          { key: 'hours_worked', title: 'Hours', align: 'right', render: (r) => (Number(r.hours_worked) ? num(r.hours_worked) : '') },
          { key: 'late_days', title: 'Late', align: 'right', render: (r) => (r.late_days ? <span className="error small">{r.late_days}</span> : 0) },
          { key: 'present', title: 'Present', align: 'right' }, { key: 'half_day', title: 'Half days', align: 'right' },
          { key: 'absent', title: 'Absent', align: 'right', render: (r) => (r.absent ? <span className="error small">{r.absent}</span> : 0) },
          { key: 'leave', title: 'Leave', align: 'right' }, { key: 'weekly_off', title: 'Weekly off', align: 'right' },
          { key: 'holiday', title: 'Holidays', align: 'right' },
          { key: 'not_marked', title: 'Not marked', align: 'right', render: (r) => (r.not_marked ? <span className="error small">{r.not_marked}</span> : 0) },
        ]} />
      </Card>
      <Card title={`Leave in ${leave.data?.fy ?? 'this year'}`} actions={<a className="button" href="/api/hr/leave-balances?format=xlsx">Excel</a>}>
        <p className="muted small">
          Everyone gets {leave.data ? num(leave.data.annual_leave_days) : '…'} days of leave in a year (April to March) unless they have their own figure;
          someone who joins part-way gets it in proportion. Leave taken is every day marked as Leave in the register.
        </p>
        {write && leave.data && (
          <Form inline submit="Change" key={leave.data.annual_leave_days}
            initial={{ annual_leave_days: leave.data.annual_leave_days }}
            fields={[{ name: 'annual_leave_days', label: 'Leave days a year', type: 'number', step: '0.5', required: true }]}
            onSubmit={(v) => api('/hr/leave-policy', { method: 'PUT', body: v })} onDone={leave.reload} />
        )}
        <Loading loading={leave.loading} error={leave.error} />
        <Table rows={leave.data?.data} empty="Nobody on the rolls this year." rowHref={(r) => `/hr/employees/${r.employee_id}`} columns={[
          { key: 'name', title: 'Employee' }, { key: 'department', title: 'Department' },
          { key: 'entitled', title: 'Entitled', align: 'right', render: (r) => <>{num(r.entitled)}{r.own_rule ? <span className="muted small"> own figure</span> : null}</> },
          { key: 'taken', title: 'Taken', align: 'right' },
          { key: 'balance', title: 'Left', align: 'right', render: (r) => (r.balance < 0 ? <span className="error small">{num(-r.balance)} over</span> : num(r.balance)) },
        ]} />
      </Card>
      <AttendanceRules canChange={write} onChange={() => { register.reload(); summary.reload(); }} />
    </Page>
  );
}
