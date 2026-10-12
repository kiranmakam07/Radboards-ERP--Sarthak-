'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ErrorBox, Loading, Notice, Page, Stat, Table, date, dateTime, inr } from '@/components/ui';
import { post, useGet } from '@/lib/api';
import { useCan } from '@/lib/session';

/**
 * Who owes us, most overdue first, with one tap to remind each of them on WhatsApp. The message is
 * written with the exact amounts and a link to every bill; sending it is noted here, so the same
 * person is not chased twice in a day by two of us.
 */
export default function RemindersPage() {
  const { data, loading, error, reload } = useGet<{ data: any[] }>('/payments/reminders');
  const can = useCan();
  const send = can('payments:write');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const list = data?.data ?? [];
  const total = list.reduce((a, p) => a + Number(p.total), 0);
  const overdue = list.reduce((a, p) => a + Number(p.overdue), 0);

  async function remind(p: any) {
    // The new tab is opened in the click itself (browsers block one opened later), then pointed at WhatsApp.
    const tab = window.open('', '_blank');
    setBusy(p.party_id);
    setProblem(null);
    setNotice(null);
    try {
      const res = await post(`/payments/reminders/${p.party_id}`);
      if (tab) tab.location.href = res.data.whatsapp_url;
      setNotice(`The reminder for ${p.party_name} is written in WhatsApp. Press send there.`);
      reload();
    } catch (e) {
      tab?.close();
      setProblem((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Page title="To collect">
      <p className="muted">Unpaid invoices by customer. A reminder opens WhatsApp with the message written: what is pending, bill by bill, with a link to each.</p>
      <Loading loading={loading && !data} error={error} />
      <Notice>{notice}</Notice>
      <ErrorBox error={problem} />
      {data && (
        <>
          <div className="stats">
            <Stat label="To collect" value={`₹${inr(total)}`} hint={`${list.length} ${list.length === 1 ? 'customer' : 'customers'}`} />
            <Stat label="Past its due date" value={overdue ? <span style={{ color: 'var(--danger)' }}>₹{inr(overdue)}</span> : '₹0.00'} />
          </div>
          <Table rows={list} empty="Nobody owes anything. Every invoice is paid." rowHref={(p) => `/parties/${p.party_id}`} columns={[
            { key: 'party_name', title: 'Customer' },
            { key: 'total', title: 'Pending', align: 'right', render: (p) => `₹${inr(p.total)}` },
            { key: 'overdue', title: 'Overdue', align: 'right', render: (p) => (Number(p.overdue) ? <span className="error small">₹{inr(p.overdue)}</span> : '') },
            { key: 'invoices', title: 'Bills', render: (p) => (
              <span style={{ whiteSpace: 'normal' }}>
                {p.invoices.slice(0, 4).map((i: any, n: number) => (
                  <span key={i.id}>{n ? ', ' : ''}<Link href={`/invoices/${i.id}`}>{i.invoice_no}</Link>
                    <span className="muted small"> ₹{inr(i.outstanding)}{i.days_overdue > 0 ? ` · ${i.days_overdue} ${i.days_overdue === 1 ? 'day' : 'days'} late` : i.due_date ? ` · due ${date(i.due_date)}` : ''}</span></span>
                ))}
                {p.invoices.length > 4 ? <span className="muted small"> and {p.invoices.length - 4} more</span> : null}
              </span>
            ) },
            { key: 'last_reminded_at', title: 'Last reminded', render: (p) => (p.last_reminded_at
              ? <>{dateTime(p.last_reminded_at)}<span className="muted small"> · {p.reminders_sent} sent</span></> : <span className="muted">Never</span>) },
            { key: 'x', title: '', render: (p) => (!send ? null : p.phone
              ? <button type="button" className="primary" disabled={busy === p.party_id} onClick={() => remind(p)}>{busy === p.party_id ? 'Writing…' : 'Remind on WhatsApp'}</button>
              : <span className="muted small">No phone number</span>) },
          ]} />
        </>
      )}
    </Page>
  );
}
