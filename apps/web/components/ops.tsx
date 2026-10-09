'use client';

import { useState } from 'react';
import { WEEKDAY_LABELS, istDate } from '@radcore/shared';
import { ActionButton, Badge, ErrorBox, Form, date, dateTime } from '@/components/ui';
import { post } from '@/lib/api';

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/** "Every day", "Monday to Saturday", "Every Monday", "Monthly on the 20th", "When needed". */
export function scheduleText(t: Record<string, any>): string {
  if (t.frequency === 'need_based') return 'When needed';
  if (t.frequency === 'monthly') return `Monthly on the ${ordinal(t.month_day ?? 1)}`;
  const days: number[] = [...t.weekdays].sort();
  if (days.length === 7) return 'Every day';
  if (days.join() === '1,2,3,4,5,6') return 'Monday to Saturday';
  const names = days.map((d) => WEEKDAY_LABELS[d]).join(', ');
  return t.frequency === 'weekly' ? `Every ${names}` : names;
}

export const everyText = (s: Record<string, any>): string =>
  `Every ${s.interval_count === 1 ? s.interval_unit.replace(/s$/, '') : `${s.interval_count} ${s.interval_unit}`}`;

/** Where a maintenance schedule stands: a coloured word, then how far off it is. */
export function Due({ schedule: s }: { schedule: Record<string, any> }) {
  if (s.state === 'off') return <Badge value="off" />;
  const days = Math.abs(s.days_left);
  const far = s.days_left < 0 ? `${days} day${days === 1 ? '' : 's'} late`
    : s.days_left === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'} (${date(s.next_due_on)})`;
  return <><Badge value={s.state === 'ok' ? 'on_track' : s.state} /> <span className="small">{far}</span></>;
}

/** One task, workable in place: tick the checklist, then finish it or say why it could not be done. */
export function TaskCard({ task, onChange, showAssignee }: { task: any; onChange: () => void; showAssignee?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = task.status === 'open';
  const left = task.checklist.filter((c: any) => !c.done).length;

  async function tick(index: number, done: boolean) {
    setBusy(true);
    setError(null);
    try {
      await post(`/ops/tasks/${task.id}/checklist`, { index, done });
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={task.overdue ? 'card task late' : 'card task'}>
      <div className="card-head">
        <h2>{task.title}</h2>
        <div className="actions">
          {task.overdue ? <Badge value="overdue" /> : null}
          {!open ? <Badge value={task.status} /> : null}
          <span className="muted small">{task.due_date === istDate() ? 'Today' : `Due ${date(task.due_date)}`}{showAssignee ? ` · ${task.assignee_name}` : ''}</span>
        </div>
      </div>
      {task.description ? <p className="muted small">{task.description}</p> : null}
      {task.checklist.length > 0 && (
        <ul className="checklist">
          {task.checklist.map((c: any, i: number) => (
            <li key={i}>
              <label className={c.done ? 'done' : undefined}>
                <input type="checkbox" checked={c.done} disabled={!open || busy} onChange={(e) => tick(i, e.target.checked)} /> {c.text}
              </label>
            </li>
          ))}
        </ul>
      )}
      {open ? (
        <div className="form-foot">
          <ActionButton kind="primary" onClick={() => post(`/ops/tasks/${task.id}/complete`, {})} onDone={onChange}>
            {left > 0 ? `Done (${left} to tick first)` : 'Done'}
          </ActionButton>
          <ActionButton onDone={(r) => r && onChange()} onClick={async () => {
            const reason = window.prompt('Why could it not be done?');
            return reason && reason.trim() ? post(`/ops/tasks/${task.id}/skip`, { reason }) : null;
          }}>Could not do it</ActionButton>
        </div>
      ) : (
        <p className="muted small">
          {task.status === 'done' ? 'Done' : 'Not done'}{task.completed_by_name ? ` by ${task.completed_by_name}` : ''} {dateTime(task.completed_at)}
          {task.note ? ` · ${task.note}` : ''}
        </p>
      )}
      <ErrorBox error={error} />
    </section>
  );
}

/** Record that a scheduled maintenance was carried out; the next due date moves on by itself. */
export function MaintenanceDone({ scheduleId, onDone }: { scheduleId: string; onDone: () => void }) {
  return (
    <Form submit="Record as done" inline
      initial={{ done_on: istDate() }}
      fields={[
        { name: 'done_on', label: 'Done on', type: 'date', required: true },
        { name: 'done_by', label: 'Done by', placeholder: 'Vendor or person' },
        { name: 'cost', label: 'Cost', type: 'number' },
        { name: 'next_due_on', label: 'Next due', type: 'date', help: 'Blank = one interval after the day it was done' },
        { name: 'notes', label: 'What was done', type: 'textarea' },
      ]}
      onSubmit={(v) => post(`/ops/schedules/${scheduleId}/done`, v)}
      onDone={onDone} />
  );
}
