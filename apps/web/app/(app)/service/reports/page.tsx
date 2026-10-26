'use client';

import { useState } from 'react';
import { Card, CsvLink, Loading, Page, Table, Tabs, dateTime, label } from '@/components/ui';
import { qs, useGet } from '@/lib/api';

type Tab = 'history' | 'technicians' | 'failures';

/** The brief's three reports: service history by serial; jobs per technician with turnaround and comebacks; failures. */
export default function ServiceReportsPage() {
  const [tab, setTab] = useState<Tab>('history');
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const [range, setRange] = useState({ from: `${today.slice(0, 7)}-01`, to: today });
  const [serial, setSerial] = useState('');
  const history = useGet<{ data: any[] }>(tab === 'history' && serial.trim().length >= 3 ? `/service/reports/history${qs({ serial: serial.trim() })}` : null);
  const techs = useGet<{ data: any[] }>(tab === 'technicians' ? `/service/reports/technicians${qs(range)}` : null);
  const comebacks = useGet<{ data: any[] }>(tab === 'technicians' ? `/service/reports/comebacks${qs(range)}` : null);
  const failures = useGet<{ data: any }>(tab === 'failures' ? `/service/reports/failures${qs(range)}` : null);
  return (
    <Page title="Service reports">
      <Tabs value={tab} onChange={setTab} tabs={[{ key: 'history', label: 'History of a serial' }, { key: 'technicians', label: 'Technicians and comebacks' }, { key: 'failures', label: 'Failures' }]} />
      {tab !== 'history' ? (
        <div className="filters">
          <label className="inline">From <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
          <label className="inline">To <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
        </div>
      ) : null}
      {tab === 'history' ? (
        <Card title="Every job on a unit, on what it is fitted in, and on the parts inside it">
          <div className="filters"><input placeholder="Serial" value={serial} onChange={(e) => setSerial(e.target.value)} /></div>
          <Loading loading={history.loading} error={history.error} />
          <Table rows={history.data?.data} rowHref={(r) => `/service/${r.id}`} empty={serial ? 'No jobs.' : 'Type a serial.'} columns={[
            { key: 'job_no', title: 'Job' }, { key: 'serial_no', title: 'On', render: (r) => `${r.item_name} ${r.serial_no}` },
            { key: 'created_at', title: 'In', render: (r) => dateTime(r.created_at) }, { key: 'complaint', title: 'Complaint' },
            { key: 'faults', title: 'Faults' }, { key: 'status', title: 'Status', render: (r) => label(r.status) },
          ]} />
        </Card>
      ) : null}
      {tab === 'technicians' ? (
        <>
          <Card title="Jobs handed back, per technician per day" actions={<CsvLink href={`/service/reports/technicians${qs(range)}`} />}>
            <Loading loading={techs.loading} error={techs.error} />
            <Table rows={techs.data?.data} empty="No jobs handed back in these dates." columns={[
              { key: 'day', title: 'Day' }, { key: 'technician', title: 'Technician' }, { key: 'jobs', title: 'Jobs', align: 'right' },
              { key: 'turnaround_hours', title: 'Turnaround (hours, average)', align: 'right' },
            ]} />
          </Card>
          <Card title="Comebacks: back within 30 days" actions={<CsvLink href={`/service/reports/comebacks${qs(range)}`} />}>
            <Loading loading={comebacks.loading} error={comebacks.error} />
            <Table rows={comebacks.data?.data} rowHref={(r) => `/service/${r.id}`} empty="No comebacks in these dates." columns={[
              { key: 'job_no', title: 'Job' }, { key: 'serial_no', title: 'Unit', render: (r) => `${r.item_name} ${r.serial_no}` },
              { key: 'complaint', title: 'Complaint' }, { key: 'previous_job_no', title: 'Last job' }, { key: 'previous_technician', title: 'Done by' },
              { key: 'days_after', title: 'Days after', align: 'right' },
            ]} />
          </Card>
        </>
      ) : null}
      {tab === 'failures' ? (
        <>
          <Loading loading={failures.loading} error={failures.error} />
          <div className="grid">
            <Card title="By model"><Table rows={failures.data?.data.by_model} empty="None." columns={[{ key: 'model', title: 'Model' }, { key: 'jobs', title: 'Jobs', align: 'right' }]} /></Card>
            <Card title="By component"><Table rows={failures.data?.data.by_component} empty="No faults recorded." columns={[
              { key: 'component', title: 'Component' }, { key: 'code', title: 'Fault', render: (r) => <>{r.code}<div className="muted small">{r.description}</div></> },
              { key: 'times', title: 'Times', align: 'right' },
            ]} /></Card>
          </div>
          <Card title="By batch"><Table rows={failures.data?.data.by_batch} empty="No faults in units with a batch." columns={[
            { key: 'part', title: 'Item' }, { key: 'batch_no', title: 'Batch' }, { key: 'supplier', title: 'Supplier' }, { key: 'faults', title: 'Faults', align: 'right' },
          ]} /></Card>
        </>
      ) : null}
    </Page>
  );
}
