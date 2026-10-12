'use client';

import { useState } from 'react';
import { INTERVIEW_RESULTS, WEEKDAY_LABELS } from '@radcore/shared';
import { ActionButton, Badge, Card, ErrorBox, Form, Notice, Table, date, label, num } from '@/components/ui';
import { post, put, useGet } from '@/lib/api';

/** Record how an interview round went. Used by HR on the applicant's page and by the interviewer on "My work". */
export function InterviewResult({ interviewId, onDone }: { interviewId: string; onDone: () => void }) {
  return (
    <Form submit="Save result" inline
      fields={[
        { name: 'result', label: 'Result', type: 'select', required: true, options: INTERVIEW_RESULTS.map((r) => ({ value: r, label: label(r) })) },
        { name: 'rating', label: 'Rating (1 to 5)', type: 'number', step: '1' },
        { name: 'feedback', label: 'Feedback', type: 'textarea' },
      ]}
      onSubmit={(v) => post(`/hr/interviews/${interviewId}/complete`, v)}
      onDone={onDone} />
  );
}

const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);

/** Where a clock-in was done, in words: at the workplace, how far from it, or not known. */
export function PlaceNote({ distance, radius, noLocation }: { distance: number | null; radius: number | null; noLocation: boolean }) {
  if (noLocation) return <span className="badge amber" title="The phone did not share where it was">No location</span>;
  if (distance === null || radius === null) return null;
  return distance <= radius
    ? <span className="badge green">At the workplace</span>
    : <span className="badge red" title="Clocked in away from the workplace">{km(distance)} away</span>;
}

/** Ask the phone where it is. Resolves to null when the person says no or the phone cannot tell in time. */
function whereAmI(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
    );
  });
}

/**
 * A person's own attendance, on "My work": clock in and out from the phone (with where they are,
 * if the phone will say), the leave they have left, and asking for leave. Shown only to someone
 * whose sign-in is linked to an employee record.
 */
export function MyAttendance() {
  const { data, reload } = useGet<{ data: any | null }>('/hr/me');
  const slips = useGet<{ data: any[] }>('/payroll/me');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const d = data?.data;
  if (!d) return null;
  const row = d.today_row;
  const radius = d.place?.radius_m ?? null;

  async function clock(which: 'in' | 'out') {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const at = await whereAmI();
      await post(`/hr/me/clock-${which}`, { at });
      setNotice(which === 'in' ? 'Clocked in. Have a good day.' : 'Clocked out.');
      if (!at) setNotice((n) => `${n} The phone did not share its location, so the register will say so.`);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="My attendance" actions={<span className="muted small">{d.employee.name} · {d.employee.employee_no}</span>}>
      <div className="clock">
        <div>
          <div className="clock-times">
            <span>In <strong>{row?.check_in ?? '—'}</strong></span>
            <span>Out <strong>{row?.check_out ?? '—'}</strong></span>
          </div>
          {row?.self_marked ? <PlaceNote distance={row.in_distance_m} radius={radius} noLocation={row.no_location} /> : null}
          {row && !row.check_in ? <Badge value={row.status} /> : null}
        </div>
        {!row?.check_in ? <button type="button" className="primary big" disabled={busy} onClick={() => clock('in')}>{busy ? 'Finding where you are…' : 'Clock in'}</button>
          : !row.check_out ? <button type="button" className="big" disabled={busy} onClick={() => clock('out')}>{busy ? 'Finding where you are…' : 'Clock out'}</button>
            : <span className="badge green">Done for today</span>}
      </div>
      <Notice>{notice}</Notice>
      <ErrorBox error={error} />
      <p className="small" style={{ margin: '10px 0 6px' }}>
        Leave this year: <strong>{num(d.leave.left)}</strong> of {num(d.leave.entitled)} days left.{' '}
        <button type="button" className="link" onClick={() => setAsking(!asking)}>{asking ? 'Never mind' : 'Ask for leave'}</button>
      </p>
      {asking ? (
        <Form submit="Send to HR" initial={{ from: d.today, to: d.today }}
          fields={[
            { name: 'from', label: 'First day', type: 'date', required: true },
            { name: 'to', label: 'Last day', type: 'date', required: true },
            { name: 'reason', label: 'Reason', required: true },
          ]}
          onSubmit={(v) => post('/hr/me/leave', v)}
          onDone={() => { setAsking(false); setNotice('Sent to HR. You will see the answer here.'); reload(); }} />
      ) : null}
      {(slips.data?.data ?? []).length > 0 ? (
        <p className="small" style={{ margin: '0 0 8px' }}>
          My payslips:{' '}
          {slips.data!.data.slice(0, 6).map((s, i) => (
            <span key={s.id}>{i ? ' · ' : ''}<a href={`/my-work/payslips/${s.id}`}>{new Date(`${s.month}-01T00:00:00Z`).toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })}</a></span>
          ))}
        </p>
      ) : null}
      {d.requests.length > 0 ? (
        <Table rows={d.requests} columns={[
          { key: 'from_date', title: 'Leave', render: (r) => (r.from_date === r.to_date ? date(r.from_date) : `${date(r.from_date)} to ${date(r.to_date)}`) },
          { key: 'days', title: 'Days', align: 'right' },
          { key: 'reason', title: 'Reason', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.reason}</span> },
          { key: 'status', title: 'Answer', render: (r) => <span style={{ whiteSpace: 'normal' }}><Badge value={r.status} />{r.decision_note ? <span className="muted small"> {r.decision_note}</span> : null}</span> },
          { key: 'x', title: '', render: (r) => (r.status === 'pending' ? <ActionButton onClick={() => post(`/hr/me/leave/${r.id}/cancel`)} onDone={reload}>Take back</ActionButton> : null) },
        ]} />
      ) : null}
    </Card>
  );
}

/** HR: leave people have asked for, waiting first. Approving writes the days into the register. */
export function LeaveRequests({ canDecide, onChange }: { canDecide: boolean; onChange: () => void }) {
  const { data, reload } = useGet<{ data: any[] }>('/hr/leave-requests');
  const [refusing, setRefusing] = useState<string | null>(null);
  const list = data?.data ?? [];
  const waiting = list.filter((r) => r.status === 'pending').length;
  if (list.length === 0) return null;
  const done = () => { setRefusing(null); reload(); onChange(); };
  return (
    <Card title={waiting ? `Leave asked for (${waiting} waiting)` : 'Leave asked for'}>
      <Table rows={list} columns={[
        { key: 'name', title: 'Employee', render: (r) => <>{r.name} <span className="muted small">{r.employee_no}</span></> },
        { key: 'from_date', title: 'Leave', render: (r) => (r.from_date === r.to_date ? date(r.from_date) : `${date(r.from_date)} to ${date(r.to_date)}`) },
        { key: 'days', title: 'Days', align: 'right' },
        { key: 'taken_this_year', title: 'Taken this year', align: 'right' },
        { key: 'reason', title: 'Reason', render: (r) => <span style={{ whiteSpace: 'normal' }}>{r.reason}</span> },
        { key: 'status', title: 'Answer', render: (r) => <span style={{ whiteSpace: 'normal' }}><Badge value={r.status} />{r.decision_note ? <span className="muted small"> {r.decision_note}</span> : null}</span> },
        { key: 'x', title: '', render: (r) => (canDecide && r.status === 'pending' ? (
          refusing === r.id ? (
            <Form submit="Refuse" inline fields={[{ name: 'note', label: 'Why', required: true }]}
              onSubmit={(v) => post(`/hr/leave-requests/${r.id}/decide`, { approve: false, note: v.note })} onDone={done} />
          ) : (
            <span className="actions">
              <ActionButton kind="primary" onClick={() => post(`/hr/leave-requests/${r.id}/decide`, { approve: true })} onDone={done}>Approve</ActionButton>
              <button type="button" onClick={() => setRefusing(r.id)}>Refuse</button>
            </span>
          )
        ) : null) },
      ]} />
    </Card>
  );
}

/** HR: when the day starts, the weekly off, and where the workplace is. */
export function AttendanceRules({ canChange, onChange }: { canChange: boolean; onChange: () => void }) {
  const { data, reload } = useGet<{ data: any }>('/hr/attendance-rules');
  const [v, setV] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const rules = data?.data;
  if (!rules) return null;
  const f = v ?? { start: rules.start ?? '', grace_min: rules.grace_min, weekly_off: rules.weekly_off, name: rules.place?.name ?? '', lat: rules.place?.lat ?? '', lng: rules.place?.lng ?? '', radius_m: rules.place?.radius_m ?? 200 };
  const set = (patch: Record<string, unknown>) => { setV({ ...f, ...patch }); setSaved(false); };

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const hasPlace = f.lat !== '' && f.lng !== '';
      await put('/hr/attendance-rules', {
        start: f.start, grace_min: Number(f.grace_min), weekly_off: f.weekly_off,
        place: hasPlace ? { name: f.name || 'Workplace', lat: Number(f.lat), lng: Number(f.lng), radius_m: Number(f.radius_m) } : null,
      });
      setSaved(true);
      setV(null);
      reload();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const summary = [
    rules.start ? `Day starts ${rules.start}, late after ${rules.grace_min} minutes` : 'No start time set, so nobody is counted late',
    rules.weekly_off.length ? `weekly off ${rules.weekly_off.map((w: number) => WEEKDAY_LABELS[w]).join(', ')}` : 'no weekly off',
    rules.place ? `workplace "${rules.place.name}" (within ${rules.place.radius_m} m)` : 'workplace not set, so clock-ins are not checked for place',
  ].join(' · ');
  if (!canChange) return <p className="muted small">{summary}</p>;
  return (
    <Card title="Attendance rules">
      <p className="muted small">{summary}</p>
      <div className="form">
        <label>Day starts at<input type="time" value={f.start} onChange={(e) => set({ start: e.target.value })} /></label>
        <label>Minutes before it counts as late<input type="number" min="0" value={f.grace_min} onChange={(e) => set({ grace_min: e.target.value })} /></label>
        <label className="wide">Weekly off
          <span className="actions">
            {WEEKDAY_LABELS.map((name: string, i: number) => (
              <label key={name} className="check"><input type="checkbox" checked={f.weekly_off.includes(i)}
                onChange={(e) => set({ weekly_off: e.target.checked ? [...f.weekly_off, i] : f.weekly_off.filter((w: number) => w !== i) })} /> {name}</label>
            ))}
          </span>
        </label>
        <label>Workplace name<input value={f.name} placeholder="e.g. Showroom" onChange={(e) => set({ name: e.target.value })} /></label>
        <label>Latitude<input value={f.lat} inputMode="decimal" onChange={(e) => set({ lat: e.target.value })} /></label>
        <label>Longitude<input value={f.lng} inputMode="decimal" onChange={(e) => set({ lng: e.target.value })} /></label>
        <label>Counts as "at the workplace" within (metres)<input type="number" min="20" value={f.radius_m} onChange={(e) => set({ radius_m: e.target.value })} /></label>
        <div className="form-foot">
          <button type="button" className="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save rules'}</button>
          <button type="button" disabled={busy} onClick={async () => {
            const at = await whereAmI();
            if (at) set({ lat: at.lat.toFixed(6), lng: at.lng.toFixed(6) });
            else setError('This device did not share its location. Type the latitude and longitude instead (from Google Maps: press and hold on the building).');
          }}>Use where I am now</button>
          {f.lat !== '' ? <button type="button" disabled={busy} onClick={() => set({ lat: '', lng: '', name: '' })}>Remove the workplace</button> : null}
          {saved ? <span className="muted small">Saved.</span> : null}
        </div>
      </div>
      <ErrorBox error={error} />
      <p className="muted small" style={{ marginBottom: 0 }}>A clock-in away from the workplace is still taken, and shows on the register as “away” with the distance, for you to judge.</p>
    </Card>
  );
}
