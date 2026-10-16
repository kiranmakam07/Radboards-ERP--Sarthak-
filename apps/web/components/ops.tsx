'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { TASK_STAGES, TASK_STAGE_LABELS, WEEKDAY_LABELS, istDate, type TaskStage } from '@radcore/shared';
import { Board } from '@/components/board';
import { ActionButton, Badge, ErrorBox, Form, Modal, date, dateTime, type Field } from '@/components/ui';
import { patch, post } from '@/lib/api';
import { useCan, useSession } from '@/lib/session';

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

/** "Today", "Today by 18:00", "12-10-2026 by 18:00": a task's deadline in words. */
export function deadlineText(task: Record<string, any>): string {
  const day = task.due_date === istDate() ? 'Today' : date(task.due_date);
  return task.due_time ? `${day} by ${task.due_time}` : day;
}

/** One task, workable in place: start it, tick the checklist, then finish it or say why it could not be done. */
export function TaskCard({ task, onChange, showAssignee, noTitle }: { task: any; onChange: () => void; showAssignee?: boolean; noTitle?: boolean }) {
  const canSeeProjects = useCan()('ops:read');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
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
        {noTitle ? null : <h2>{task.title}</h2>}
        <div className="actions">
          {task.overdue ? <Badge value="overdue" /> : null}
          {!open ? <Badge value={task.status} /> : task.stage === 'in_progress' ? <Badge value="in_progress" /> : null}
          <span className="muted small">Deadline: {deadlineText(task)}{showAssignee ? ` · ${task.assignee_name}` : ''}</span>
        </div>
      </div>
      {/* Someone given a task on a project need not be able to open the project itself: then it is named, not linked. */}
      {task.project_id ? <p className="small">Project: {canSeeProjects
        ? <Link href={`/ops/projects/${task.project_id}`}>{task.project_no} · {task.project_name}</Link>
        : <>{task.project_no} · {task.project_name}</>}</p> : null}
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
      {open && asking ? (
        <SkipReason taskId={task.id} onCancel={() => setAsking(false)} onDone={() => { setAsking(false); onChange(); }} />
      ) : open ? (
        <div className="form-foot">
          {task.stage === 'todo' ? (
            <ActionButton onClick={() => post(`/ops/tasks/${task.id}/move`, { to: 'in_progress' })} onDone={onChange}>Start work</ActionButton>
          ) : null}
          <ActionButton kind="primary" onClick={() => post(`/ops/tasks/${task.id}/complete`, {})} onDone={onChange}>
            {left > 0 ? `Done (${left} to tick first)` : 'Done'}
          </ActionButton>
          <button type="button" onClick={() => setAsking(true)}>Could not do it</button>
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

/** Why a task could not be done: required, and kept with the task. */
function SkipReason({ taskId, onCancel, onDone }: { taskId: string; onCancel: () => void; onDone: () => void }) {
  return (
    <div className="toggle-body">
      <Form submit="Close it as not done"
        fields={[{ name: 'reason', label: 'Why could it not be done?', type: 'textarea', required: true }]}
        onSubmit={(v) => post(`/ops/tasks/${taskId}/move`, { to: 'skipped', reason: v.reason })}
        onDone={onDone} />
      <p><button type="button" className="link" onClick={onCancel}>Keep it open</button></p>
    </div>
  );
}

/** The boxes of a new task. `withStart` adds the start date that project tasks have. */
export function taskFields(people: { value: string; label: string }[], withStart = false): Field[] {
  return [
    { name: 'title', label: 'What needs doing', required: true },
    { name: 'assignee_id', label: 'Who', type: 'select', required: true, options: people },
    ...(withStart ? [{ name: 'start_date', label: 'Starts', type: 'date' as const, help: 'Optional' }] : []),
    { name: 'due_date', label: 'Deadline', type: 'date', required: true },
    { name: 'due_time', label: 'By what time', type: 'time', help: 'Blank = any time that day' },
    { name: 'checklist', label: 'Checklist (one step per line)', type: 'textarea' },
    { name: 'description', label: 'Details', type: 'textarea' },
  ];
}

/** A checklist typed one step per line, as the API wants it. */
export const checklistLines = (v: unknown) => String(v ?? '').split('\n').map((x) => x.trim()).filter(Boolean);

const taskColumns = (recentOnly: boolean) => TASK_STAGES.map((key) => ({
  key,
  title: TASK_STAGE_LABELS[key],
  hint: recentOnly && (key === 'done' || key === 'skipped') ? 'Closed in the last 14 days' : undefined,
}));

/** What a drop asks for before it can happen. */
type Asking =
  | { kind: 'reason'; task: any }
  | { kind: 'checklist'; task: any }
  | { kind: 'reopen'; task: any; to: TaskStage };

/**
 * Tasks as a board: To do, In progress, Done, Could not do. A card is dragged to another column;
 * a move that needs something first asks for it in a pop-up (why it could not be done, the
 * checklist ticked, a yes to reopening a closed task). Clicking a card opens it in a pop-up.
 * The rules are the API's (moveTask in apps/api/src/modules/ops.ts); this only asks politely first.
 */
export function TaskBoard({ tasks, onChange, people, showProject = true, recentOnly = true }: {
  tasks: any[]; onChange: () => void; people: { value: string; label: string }[];
  /** Name each card's project (off on a project's own page). */
  showProject?: boolean;
  /** The closed columns hold only the last fortnight (the API's board view), as their note says. */
  recentOnly?: boolean;
}) {
  const columns = taskColumns(recentOnly);
  const { user } = useSession();
  const manage = useCan()('ops:manage');
  const [moving, setMoving] = useState<Record<string, TaskStage>>({});
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  // A card shows in its new column at once; the fresh list from the server then takes over.
  useEffect(() => { setMoving({}); }, [tasks]);

  const opened = tasks.find((t) => t.id === openId);
  // Open work by deadline, soonest (and late) first; closed work most recently closed first.
  const deadline = (t: any) => `${t.due_date} ${t.due_time ?? '99:99'}`;
  const ordered = [...tasks].sort((a, b) => (a.status === 'open' && b.status === 'open'
    ? deadline(a).localeCompare(deadline(b))
    : String(b.completed_at ?? '').localeCompare(String(a.completed_at ?? ''))));
  const backTo = (t: any): TaskStage[] => (t.status !== 'open' ? ['todo', 'in_progress'] : t.stage === 'in_progress' ? ['todo'] : []);
  const mayMove = (t: any) => manage || (t.assignee_id === user.id && t.status === 'open');

  async function go(task: any, to: TaskStage, reason?: string) {
    setError(null);
    setMoving((m) => ({ ...m, [task.id]: to }));
    try {
      await post(`/ops/tasks/${task.id}/move`, { to, reason });
      onChange();
    } catch (e) {
      setMoving((m) => {
        const { [task.id]: _gone, ...rest } = m;
        return rest;
      });
      setError(`${task.title}: ${(e as Error).message}`);
    }
  }

  function move(task: any, to: string) {
    const stage = to as TaskStage;
    const closed = task.status !== 'open';
    if (closed && (stage === 'todo' || stage === 'in_progress')) return setAsking({ kind: 'reopen', task, to: stage });
    if (stage === 'skipped') return setAsking({ kind: 'reason', task });
    if (stage === 'done' && task.checklist.some((c: any) => !c.done)) return setAsking({ kind: 'checklist', task });
    void go(task, stage);
  }

  return (
    <>
      <ErrorBox error={error} />
      <Board columns={columns} items={ordered} keyOf={(t) => t.id} columnOf={(t) => moving[t.id] ?? t.stage}
        canMove={mayMove} onMove={move} onOpen={(t) => setOpenId(t.id)} emptyColumn="No tasks"
        render={(t) => (
          <>
            <div className="title">{t.title}</div>
            <div className="meta">
              <span>{t.assignee_name}</span>
              <span className={t.overdue ? 'late' : undefined}>{t.overdue ? 'Late · ' : ''}{deadlineText(t)}</span>
              {t.checklist_total ? <span>☑ {t.checklist_done}/{t.checklist_total}</span> : null}
              {showProject && t.project_no ? <span>{t.project_no}</span> : null}
            </div>
          </>
        )} />

      {opened ? (
        <TaskModal task={opened} people={people} onChange={onChange} onClose={() => setOpenId(null)}>
          {/* The task's own buttons start it, finish it or close it as not done; this row adds the moves back. */}
          {mayMove(opened) && backTo(opened).length ? (
            <div className="move-to">
              <span className="muted small">Move back to</span>
              {columns.filter((c) => backTo(opened).includes(c.key)).map((c) => (
                <button key={c.key} type="button" onClick={() => { setOpenId(null); move(opened, c.key); }}>{c.title}</button>
              ))}
            </div>
          ) : null}
        </TaskModal>
      ) : null}

      {asking?.kind === 'reason' ? (
        <Modal title={`Could not do: ${asking.task.title}`} onClose={() => setAsking(null)}>
          <p className="muted small">Boxes marked * must be filled in.</p>
          <Form submit="Close it as not done"
            fields={[{ name: 'reason', label: 'Why could it not be done?', type: 'textarea', required: true }]}
            onSubmit={(v) => post(`/ops/tasks/${asking.task.id}/move`, { to: 'skipped', reason: v.reason })}
            onDone={() => { setAsking(null); onChange(); }} />
        </Modal>
      ) : null}

      {asking?.kind === 'checklist' ? (
        <ChecklistFirst task={tasks.find((t) => t.id === asking.task.id) ?? asking.task} onChange={onChange}
          onClose={() => setAsking(null)} onDone={(t) => { setAsking(null); void go(t, 'done'); }} />
      ) : null}

      {asking?.kind === 'reopen' ? (
        <Modal title={`Open "${asking.task.title}" again?`} onClose={() => setAsking(null)}>
          <p>It was closed as {asking.task.status === 'done' ? 'done' : `not done${asking.task.note ? ` (${asking.task.note})` : ''}`}.
            It goes back to {TASK_STAGE_LABELS[asking.to]}, and its checklist stays as it is.</p>
          <div className="form-foot">
            <button type="button" className="primary" onClick={() => { const a = asking; setAsking(null); void go(a.task, a.to); }}>Open it again</button>
            <button type="button" onClick={() => setAsking(null)}>Keep it closed</button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

/**
 * A task opened in a pop-up: the task itself to work on, and for operations its person and
 * deadline to change. `children` go at the bottom (the board puts its Move to buttons there).
 */
export function TaskModal({ task, people, onChange, onClose, children }: {
  task: any; people: { value: string; label: string }[]; onChange: () => void; onClose: () => void; children?: ReactNode;
}) {
  const manage = useCan()('ops:manage');
  return (
    <Modal title={task.title} wide onClose={onClose}>
      <TaskCard task={task} onChange={onChange} showAssignee noTitle />
      {manage && task.status === 'open' ? (
        <Form key={`${task.id}${task.assignee_id}${task.due_date}${task.due_time}`} submit="Save" inline
          initial={{ assignee_id: task.assignee_id, due_date: task.due_date, due_time: task.due_time ?? '' }}
          fields={[
            { name: 'assignee_id', label: 'Give to', type: 'select', required: true, options: people },
            { name: 'due_date', label: 'Deadline', type: 'date', required: true },
            { name: 'due_time', label: 'By what time', type: 'time' },
          ]}
          onSubmit={(v) => patch(`/ops/tasks/${task.id}`, v)}
          onDone={onChange} />
      ) : null}
      {children}
    </Modal>
  );
}

/** Dropped on Done with steps still unticked: tick them here, then it is done. */
function ChecklistFirst({ task, onChange, onClose, onDone }: { task: any; onChange: () => void; onClose: () => void; onDone: (task: any) => void }) {
  const [error, setError] = useState<string | null>(null);
  const left = task.checklist.filter((c: any) => !c.done).length;
  const open = task.status === 'open';
  async function tick(index: number, done: boolean) {
    setError(null);
    try {
      await post(`/ops/tasks/${task.id}/checklist`, { index, done });
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal title={`Finish: ${task.title}`} onClose={onClose}>
      {open ? <p>Every step is ticked before a task is done. {left > 0 ? `${left} still to tick:` : 'All ticked.'}</p>
        : <p>This task is closed, and its checklist was never finished. Move it back to In progress, tick the steps, then move it to Done.</p>}
      <ul className="checklist">
        {task.checklist.map((c: any, i: number) => (
          <li key={i}>
            <label className={c.done ? 'done' : undefined}>
              <input type="checkbox" checked={c.done} disabled={!open} onChange={(e) => tick(i, e.target.checked)} /> {c.text}
            </label>
          </li>
        ))}
      </ul>
      <ErrorBox error={error} />
      <div className="form-foot">
        <button type="button" className="primary" disabled={!open || left > 0} onClick={() => onDone(task)}>Mark done</button>
        <button type="button" onClick={onClose}>Not yet</button>
      </div>
    </Modal>
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
