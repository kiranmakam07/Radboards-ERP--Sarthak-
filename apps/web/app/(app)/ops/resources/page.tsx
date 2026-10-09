'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { addDays, istDate, weekStart } from '@radcore/shared';
import { ActionButton, Card, Form, Loading, Page, Stat, Table, date, label } from '@/components/ui';
import { ApiError, api, patch, post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const tone = (load: number) => (load > 100 ? 'over' : load >= 100 ? 'l3' : load > 50 ? 'l2' : load > 0 ? 'l1' : 'l0');

/** One cell of the board: how much of that week is promised. Over 100% is spelled out, not only coloured. */
function LoadCell({ load }: { load: number }) {
  return <td className={`load ${tone(load)}`} title={load > 100 ? 'Double-booked' : undefined}>{load === 0 ? 'Free' : load > 100 ? `⚠ ${load}%` : `${load}%`}</td>;
}

function Board({ title, rows, weeks, firstColumn, secondColumn, selected, onSelect, empty }: {
  title: string; rows: any[]; weeks: { start: string; end: string }[]; firstColumn: (r: any) => ReactNode; secondColumn: [string, (r: any) => ReactNode];
  selected: string | null; onSelect: (id: string) => void; empty: ReactNode;
}) {
  return (
    <Card title={title}>
      {rows.length === 0 ? <p className="muted">{empty}</p> : (
        <div className="table-wrap">
          <table className="load-grid">
            <thead>
              <tr><th>Name</th><th>{secondColumn[0]}</th>{weeks.map((w) => <th key={w.start} title={`${date(w.start)} to ${date(w.end)}`}>{short(w.start)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={selected === r.id ? 'selected' : undefined}>
                  <td><button type="button" className="link" onClick={() => onSelect(r.id)}>{firstColumn(r)}</button></td>
                  <td>{secondColumn[1](r)}</td>
                  {r.load.map((l: number, i: number) => <LoadCell key={weeks[i]!.start} load={l} />)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="load-key">
        <span><i className="load l0" />Free</span><span><i className="load l1" />Up to half</span><span><i className="load l2" />More than half</span>
        <span><i className="load l3" />Fully committed</span><span><i className="load over" />Double-booked</span>
        <span>Each week shows its busiest day. Weeks start on Monday.</span>
      </div>
    </Card>
  );
}

export default function ResourcesPage() {
  const can = useCan();
  const manage = can('ops:manage');
  const [from, setFrom] = useState(weekStart(istDate()));
  const [picked, setPicked] = useState<string | null>(null);
  const { data, loading, error, reload } = useGet<{ data: any }>(`/ops/resources?from=${from}&weeks=8`);
  const projects = useGet<{ data: any[] }>('/ops/projects?view=live');
  const d = data?.data;
  const everyone: any[] = d ? [...d.people, ...d.assets] : [];
  const chosen = everyone.find((r) => r.id === picked);
  const thisWeek = (rows: any[]) => rows.map((r) => r.load[0] as number);
  const free = d ? thisWeek(d.people).filter((l) => l === 0).length : 0;
  const over = d ? everyone.filter((r) => r.load.some((l: number) => l > 100)).length : 0;

  /** Allocate, and if that would take someone past all of their time, show what it clashes with and ask. */
  async function allocate(v: Record<string, any>) {
    const body = {
      ...v, employee_id: v.kind === 'asset' ? '' : v.employee_id, asset_id: v.kind === 'asset' ? v.asset_id : '',
      project_id: v.project_id ?? '', label: v.project_id ? '' : v.label,
    };
    try {
      return await post('/ops/allocations', body);
    } catch (e) {
      const err = e as ApiError;
      const clashes = (err.details as { clashes?: { work: string; percent: number }[] } | undefined)?.clashes;
      if (err.status !== 409 || !clashes) throw e;
      if (!window.confirm(`${err.message}. Already on: ${clashes.map((c) => `${c.work} (${c.percent}%)`).join(', ')}. Allocate anyway?`)) throw e;
      return post('/ops/allocations', { ...body, allow_over: true });
    }
  }

  return (
    <Page title="Resource allocation" actions={
      <>
        <button type="button" onClick={() => setFrom(addDays(from, -28))}>← Earlier</button>
        <button type="button" onClick={() => setFrom(weekStart(istDate()))}>This week</button>
        <button type="button" onClick={() => setFrom(addDays(from, 28))}>Later →</button>
      </>
    }>
      <p className="muted">Who and what is committed to which work, week by week, so you can see who is free before promising them to something new.</p>
      <Loading loading={loading && !d} error={error} />
      {d && (
        <>
          <div className="stats">
            <Stat label="People on the rolls" value={d.people.length} />
            <Stat label="Free in the first week shown" value={free} hint={`week of ${short(d.weeks[0].start)}`} />
            <Stat label="Double-booked in these 8 weeks" value={over ? <span style={{ color: 'var(--danger)' }}>{over}</span> : 0} hint="people and machines" />
            <Stat label="Machines and vehicles" value={d.assets.length} />
          </div>

          <Board title="People" rows={d.people} weeks={d.weeks} selected={picked} onSelect={(id) => setPicked(picked === id ? null : id)}
            firstColumn={(r) => r.name}
            secondColumn={['Department', (r) => <>{r.department}{r.late_tasks ? <span className="error small"> {r.late_tasks} late</span> : r.open_tasks ? <span className="muted small"> · {r.open_tasks} open tasks</span> : null}</>]}
            empty={<>Nobody is on the rolls yet. Add people under <Link href="/hr/employees">HR → Employees</Link> and they appear here.</>} />

          <Board title="Machines and vehicles" rows={d.assets} weeks={d.weeks} selected={picked} onSelect={(id) => setPicked(picked === id ? null : id)}
            firstColumn={(r) => r.name} secondColumn={['Kind', (r) => label(r.category)]}
            empty={<>No assets yet. Add them under <Link href="/ops/assets">Assets &amp; maintenance</Link>.</>} />

          {chosen && (
            <Card title={`${chosen.name}: what they are on`}>
              <Table rows={chosen.allocations} empty="Nothing in these weeks." columns={[
                { key: 'work', title: 'Work', render: (r) => (r.project_id ? <Link href={`/ops/projects/${r.project_id}`}>{r.project_no} · {r.project_name}</Link> : r.label) },
                { key: 'role', title: 'Doing' },
                { key: 'percent', title: 'Share', align: 'right', render: (r) => `${r.percent}%` },
                { key: 'from_date', title: 'From', render: (r) => date(r.from_date) },
                { key: 'to_date', title: 'To', render: (r) => date(r.to_date) },
                { key: 'actions', title: '', render: (r) => (manage ? (
                  <>
                    <ActionButton onDone={(x) => x && reload()} onClick={async () => {
                      const until = window.prompt('End this allocation on which date? (YYYY-MM-DD)', r.to_date);
                      return until ? patch(`/ops/allocations/${r.id}`, { to_date: until }) : null;
                    }}>Change end date</ActionButton>{' '}
                    <ActionButton onClick={() => api(`/ops/allocations/${r.id}`, { method: 'DELETE' })} onDone={reload} confirm="Remove this allocation?">Remove</ActionButton>
                  </>
                ) : null) },
              ]} />
            </Card>
          )}

          {manage && (
            <Card title="Allocate someone or something">
              <Form submit="Allocate"
                initial={{ kind: 'person', percent: 100, from_date: istDate() }}
                fields={[
                  { name: 'kind', label: 'Allocate a', type: 'select', required: true, options: [{ value: 'person', label: 'Person' }, { value: 'asset', label: 'Machine or vehicle' }] },
                  { name: 'employee_id', label: 'Person', type: 'select', options: d.people.map((e: any) => ({ value: e.id, label: `${e.name} (${e.department})` })) },
                  { name: 'asset_id', label: 'Machine or vehicle', type: 'select', options: d.assets.map((a: any) => ({ value: a.id, label: a.name })) },
                  { name: 'project_id', label: 'To project', type: 'select', options: (projects.data?.data ?? []).map((p) => ({ value: p.id, label: `${p.project_no} · ${p.name}` })) },
                  { name: 'label', label: 'Or: other work', placeholder: 'e.g. Showroom duty', help: 'Use this when it is not a project' },
                  { name: 'from_date', label: 'From', type: 'date', required: true },
                  { name: 'to_date', label: 'To', type: 'date', required: true },
                  { name: 'percent', label: 'Share of their time (%)', type: 'number', step: '5', required: true },
                  { name: 'role', label: 'Doing what' },
                ]}
                onSubmit={allocate}
                onDone={reload} />
            </Card>
          )}
        </>
      )}
    </Page>
  );
}
