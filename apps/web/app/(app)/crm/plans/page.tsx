'use client';

import { useState } from 'react';
import { ActionButton, Badge, Card, ErrorBox, Loading, Page, Table, Toggle } from '@/components/ui';
import { patch, post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

type Step = { after_days: string; what: string; template_id: string };
const START: Step[] = [
  { after_days: '0', what: 'Say hello', template_id: '' },
  { after_days: '2', what: 'Follow up', template_id: '' },
  { after_days: '7', what: 'Last check', template_id: '' },
];

function NewPlan({ templates, onDone }: { templates: any[]; onDone: () => void }) {
  const [name, setName] = useState('');
  const [usual, setUsual] = useState(false);
  const [steps, setSteps] = useState<Step[]>(START);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (i: number, p: Partial<Step>) => setSteps(steps.map((s, n) => (n === i ? { ...s, ...p } : s)));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await post('/leads/plans', { name, is_default: usual, steps: steps.map((s) => ({ ...s, after_days: Number(s.after_days) })) });
      setName('');
      setSteps(START);
      setUsual(false);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="form" style={{ marginBottom: 10 }}>
        <label>Name of the plan<input value={name} placeholder="e.g. New enquiry" onChange={(e) => setName(e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={usual} onChange={(e) => setUsual(e.target.checked)} /> Put every new lead on this plan</label>
      </div>
      <div className="table-wrap stack">
        <table>
          <thead><tr><th>On day</th><th>What to do</th><th>Message to send</th><th /></tr></thead>
          <tbody>
            {steps.map((s, i) => (
              <tr key={i}>
                <td data-label="On day"><input type="number" min="0" inputMode="numeric" value={s.after_days} style={{ width: 90 }} aria-label={`Step ${i + 1}: day`} onChange={(e) => set(i, { after_days: e.target.value })} /></td>
                <td data-label="What to do"><input value={s.what} aria-label={`Step ${i + 1}: what to do`} onChange={(e) => set(i, { what: e.target.value })} /></td>
                <td data-label="Message to send">
                  <select value={s.template_id} aria-label={`Step ${i + 1}: message`} onChange={(e) => set(i, { template_id: e.target.value })}>
                    <option value="">No message: a call</option>{templates.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </td>
                <td data-label="">{steps.length > 1 ? <button type="button" onClick={() => setSteps(steps.filter((_, n) => n !== i))}>Remove</button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="form-foot" style={{ marginTop: 10 }}>
        <button type="button" onClick={() => setSteps([...steps, { after_days: String(Number(steps.at(-1)?.after_days ?? 0) + 3), what: '', template_id: '' }])}>+ Add a step</button>
        <button type="button" className="primary" disabled={busy || !name.trim() || steps.some((s) => !s.what.trim())} onClick={save}>{busy ? 'Saving…' : 'Save the plan'}</button>
        <span className="muted small">Day 0 is the day the lead goes on the plan.</span>
      </div>
      <ErrorBox error={error} />
    </>
  );
}

/**
 * Follow-up plans: the steps a lead is taken through over days and weeks. A lead on a plan comes
 * up as due on the day of each step, with that step's message one tap away.
 */
export default function PlansPage() {
  const { data, loading, error, reload } = useGet<{ data: any[] }>('/leads/plans');
  const templates = useGet<{ data: any[] }>('/crm/templates');
  const can = useCan();
  const manage = can('crm:manage');
  const name = (id: string | null) => (id ? (templates.data?.data ?? []).find((t) => t.id === id)?.name ?? 'a message' : null);

  return (
    <Page title="Follow-up plans">
      <p className="muted">
        A plan is a list of steps: say hello on day 0, follow up on day 2, check one last time on day 7. A lead on a plan is due on the day
        of its next step, and the step&apos;s message is one tap away on the lead&apos;s page. The plan stops by itself when the lead replies, buys or is lost.
      </p>
      {manage && <Toggle label="+ New plan"><NewPlan templates={templates.data?.data ?? []} onDone={reload} /></Toggle>}
      <Loading loading={loading} error={error} />
      {(data?.data ?? []).length === 0 && !loading ? <p className="muted">No plans yet.</p> : null}
      <div className="grid">
        {(data?.data ?? []).map((p) => (
          <Card key={p.id} title={p.name} actions={
            <>
              {p.is_default ? <span className="badge blue">Every new lead</span> : null}
              <Badge value={p.active ? 'active' : 'switched_off'} />
            </>
          }>
            <Table rows={p.steps} columns={[
              { key: 'after_days', title: 'Day', align: 'right' },
              { key: 'what', title: 'What to do' },
              { key: 'template_id', title: 'Message', render: (s) => name(s.template_id) ?? <span className="muted">a call</span> },
            ]} />
            <p className="muted small">{p.leads_on_it} {p.leads_on_it === 1 ? 'lead is' : 'leads are'} on this plan now.</p>
            {manage ? (
              <div className="actions">
                {p.active && !p.is_default ? <ActionButton onClick={() => patch(`/leads/plans/${p.id}`, { is_default: true })} onDone={reload}>Use for every new lead</ActionButton> : null}
                {p.is_default ? <ActionButton onClick={() => patch(`/leads/plans/${p.id}`, { is_default: false })} onDone={reload}>Stop using for new leads</ActionButton> : null}
                <ActionButton onClick={() => patch(`/leads/plans/${p.id}`, { active: !p.active })} onDone={reload}>{p.active ? 'Switch off' : 'Switch on'}</ActionButton>
              </div>
            ) : null}
          </Card>
        ))}
      </div>
    </Page>
  );
}
