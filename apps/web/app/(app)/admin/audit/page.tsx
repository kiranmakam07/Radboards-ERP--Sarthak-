'use client';

import { useState } from 'react';
import { Card, CsvLink, Loading, Page, Table, dateTime, label } from '@/components/ui';
import { qs, useGet } from '@/lib/api';

/** Field names that are bookkeeping, not something a person changed. */
const QUIET = new Set(['updated_at', 'updatedAt', 'created_at', 'createdAt', 'created_by', 'createdBy', 'id']);

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—'
  : Array.isArray(v) ? `${v.length} ${v.length === 1 ? 'line' : 'lines'}` : typeof v === 'object' ? '…' : String(v).slice(0, 40));

/** The first few fields of a record, for an entry that has only an "after". */
const fields = (v: Record<string, unknown>) => Object.keys(v).filter((k) => !QUIET.has(k) && !k.endsWith('_id') && !k.endsWith('Id'))
  .slice(0, 4).map((k) => `${label(k)}: ${show(v[k])}`).join('; ');

/** What changed, in a line: "status: draft → confirmed; rate: 3500 → 3400". */
function changes(action: string, before: any, after: any): string {
  if (Array.isArray(before) || Array.isArray(after)) {
    return `items changed${Array.isArray(before) ? ` from ${show(before)}` : ''}${Array.isArray(after) ? ` to ${show(after)}` : ''}`;
  }
  if (!before && after) return action === 'create' ? 'created' : typeof after === 'object' ? fields(after) : String(after);
  if (before && !after) return 'removed';
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return '';
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !QUIET.has(k));
  const changed = keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  const text = changed.slice(0, 4).map((k) => `${label(k)}: ${show(before[k])} → ${show(after[k])}`).join('; ');
  return changed.length > 4 ? `${text}; and ${changed.length - 4} more` : text;
}

/**
 * The audit trail: every create, change, cancellation and approval, with who did it and when. Nothing
 * in it can be changed or deleted, by anyone (the database refuses).
 */
export default function AuditPage() {
  const [entity, setEntity] = useState('');
  const all = useGet<{ data: any[] }>('/settings/audit-log?limit=1000');
  const { data, loading, error } = useGet<{ data: any[] }>(entity ? `/settings/audit-log${qs({ entity, limit: 1000 })}` : null);
  const rows = entity ? data?.data : all.data?.data;
  const kinds = [...new Set((all.data?.data ?? []).map((r) => r.entity as string))].sort();

  return (
    <Page title="Audit trail" actions={<CsvLink href={`/settings/audit-log${qs({ entity, limit: 1000 })}`} />}>
      <div className="form inline" style={{ marginBottom: 12 }}>
        <label><span>Kind of record</span>
          <select value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">Everything</option>
            {kinds.map((k) => <option key={k} value={k}>{label(k)}</option>)}
          </select>
        </label>
      </div>
      <Loading loading={(entity ? loading : all.loading) && !rows} error={entity ? error : all.error} />
      <Table rows={rows} empty="Nothing recorded yet." columns={[
        { key: 'at', title: 'When', render: (r) => dateTime(r.at) },
        { key: 'user_name', title: 'Who', render: (r) => r.user_name ?? 'The system' },
        { key: 'entity', title: 'Record', render: (r) => label(r.entity) },
        { key: 'action', title: 'What', render: (r) => label(r.action) },
        { key: 'changes', title: 'Changed', render: (r) => <span style={{ whiteSpace: 'normal' }}>{changes(r.action, r.before, r.after)}</span> },
      ]} />
      <p className="muted small">The latest 1,000 entries. Download them for a longer look.</p>
      <AccessLog />
    </Page>
  );
}

/** DPDP (brief P3): who opened which customer's full record, with its phone number and address. */
function AccessLog() {
  const { data, loading, error } = useGet<{ data: any[] }>('/settings/access-log?limit=500');
  return (
    <Card title="Who opened a customer's record" actions={<CsvLink href="/settings/access-log?limit=1000" />}>
      <Loading loading={loading} error={error} />
      <Table rows={data?.data} empty="Nobody has opened one yet." columns={[
        { key: 'at', title: 'When', render: (r) => dateTime(r.at) },
        { key: 'user_name', title: 'Who', render: (r) => <>{r.user_name}<div className="muted small">{label(r.role)}</div></> },
        { key: 'record_type', title: 'Record', render: (r) => (r.record_type === 'lead' ? 'Lead' : 'Customer or supplier') },
        { key: 'record_name', title: 'Whose', render: (r) => <>{r.record_name}<div className="muted small">{r.record_ref}</div></> },
      ]} />
      <p className="muted small">In lists, phone numbers and addresses are masked for anyone who does not need them; opening the record shows them, and is noted here.</p>
    </Card>
  );
}
