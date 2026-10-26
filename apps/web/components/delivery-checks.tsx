'use client';

import { useState } from 'react';
import { Card, ErrorBox, UploadField } from '@/components/ui';
import { put } from '@/lib/api';

/**
 * The checks before a vehicle is handed over (brief P2): the pre-delivery inspection, the rider briefing,
 * the warranty registered, a photo at delivery and the signed delivery note. The API refuses the delivery
 * of a vehicle until all five are done; this is where they are ticked and attached.
 */
export type Checks = {
  pdi_done: boolean; rider_briefing: boolean; warranty_registered: boolean; photo_file_id: string | null; signed_note_file_id: string | null;
};
export const NO_CHECKS: Checks = { pdi_done: false, rider_briefing: false, warranty_registered: false, photo_file_id: null, signed_note_file_id: null };
export const checksDone = (c: Checks) => c.pdi_done && c.rider_briefing && c.warranty_registered && Boolean(c.photo_file_id) && Boolean(c.signed_note_file_id);
const fileId = (url: string) => (url ? url.split('/').pop() ?? null : null);

/** The five checks as boxes and two uploads, for a form that sends them with something else (the quick bill). */
export function DeliveryChecklist({ value, onChange }: { value: Checks; onChange: (c: Checks) => void }) {
  const tick = (k: 'pdi_done' | 'rider_briefing' | 'warranty_registered', label: string) => (
    <label className="check"><input type="checkbox" checked={value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.checked })} /> <span>{label}</span></label>
  );
  return (
    <div className="form">
      {tick('pdi_done', 'Pre-delivery inspection done')}
      {tick('rider_briefing', 'Rider briefed')}
      {tick('warranty_registered', 'Warranty registered')}
      <label><span>Photo at delivery</span>
        <UploadField purpose="delivery" value={value.photo_file_id ? `/api/files/${value.photo_file_id}` : ''} onChange={(url) => onChange({ ...value, photo_file_id: fileId(url) })} />
      </label>
      <label><span>Signed delivery note</span>
        <UploadField purpose="delivery" value={value.signed_note_file_id ? `/api/files/${value.signed_note_file_id}` : ''} onChange={(url) => onChange({ ...value, signed_note_file_id: fileId(url) })} />
      </label>
    </div>
  );
}

/** The checklist on an order with a vehicle on it, saved as it is ticked. */
export function DeliveryChecksCard({ orderId, checks, canEdit, onDone }: { orderId: string; checks: Checks | null; canEdit: boolean; onDone: () => void }) {
  const [value, setValue] = useState<Checks>(checks ?? NO_CHECKS);
  const [error, setError] = useState<string | null>(null);
  const save = async (next: Checks) => {
    setValue(next); setError(null);
    try { await put(`/sales/orders/${orderId}/delivery-checks`, next); onDone(); } catch (e) { setError((e as Error).message); }
  };
  return (
    <Card title="Delivery checklist" id="checklist">
      <p className={checksDone(value) ? 'muted small' : 'error small'} style={{ marginTop: 0 }}>
        {checksDone(value) ? 'All done: the vehicle can be handed over.' : 'A vehicle is handed over only once all five are done.'}
      </p>
      {canEdit ? <DeliveryChecklist value={value} onChange={(c) => void save(c)} /> : (
        <ul className="small">
          <li>Pre-delivery inspection: {value.pdi_done ? 'done' : 'not yet'}</li><li>Rider briefing: {value.rider_briefing ? 'done' : 'not yet'}</li>
          <li>Warranty registered: {value.warranty_registered ? 'yes' : 'not yet'}</li>
          <li>Photo: {value.photo_file_id ? <a href={`/api/files/${value.photo_file_id}`} target="_blank" rel="noreferrer">open</a> : 'not yet'}</li>
          <li>Signed note: {value.signed_note_file_id ? <a href={`/api/files/${value.signed_note_file_id}`} target="_blank" rel="noreferrer">open</a> : 'not yet'}</li>
        </ul>
      )}
      <ErrorBox error={error} />
    </Card>
  );
}
