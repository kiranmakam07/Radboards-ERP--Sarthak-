'use client';

import Link from 'next/link';
import { APPLICANT_STAGE_LABELS, OPEN_APPLICANT_STAGES, type ApplicantStage } from '@radcore/shared';
import { BarList, ChartCard, Flow, LineChart, MeterList, fillDays, plural } from '@/components/charts';
import { useRange } from '@/components/range';
import { Card, Loading, Page, Stat, Table, date, dateTime, label, num } from '@/components/ui';
import { useGet } from '@/lib/api';

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}% of those received` : undefined);

export default function HrDashboard() {
  const { query, picker } = useRange();
  const { data, loading, error } = useGet<{ data: any }>(`/hr/dashboard${query}`);
  const d = data?.data;
  const inStage = (s: ApplicantStage) => d?.pipeline.find((p: any) => p.stage === s)?.count ?? 0;
  const att = d?.attendance_today;

  return (
    <Page title="HR dashboard">
      {picker}
      <Loading loading={loading} error={error} />
      {d && (
        <>
          <Flow title="From application to joining: who is where right now" steps={[
            ...OPEN_APPLICANT_STAGES.map((s) => ({
              label: APPLICANT_STAGE_LABELS[s], value: inStage(s), href: `/hr/applicants?stage=${s}`,
              note: s === 'applied' ? 'to be screened' : s === 'interview' && d.interviews_awaiting_result.count ? `${plural(d.interviews_awaiting_result.count, 'result')} awaited` : undefined,
              alert: s === 'interview' && d.interviews_awaiting_result.count > 0,
            })),
            { label: 'Hired', value: d.hiring.hired, note: 'in this period', href: '/hr/applicants?stage=hired' },
          ]} />

          <div className="stats">
            <Stat label="Resumes received" value={d.totals.received} hint={`${date(d.range.from)} to ${date(d.range.to)}`} />
            <Stat label="Qualified" value={d.totals.qualified} hint={pct(d.totals.qualified, d.totals.received) ?? 'shortlisted or interviewed'} />
            <Stat label="Rejected" value={d.totals.rejected} hint={`of those received · ${d.totals.rejected_at_screening} at screening`} />
            <Stat label="Still being decided" value={d.totals.in_progress} hint="of those received" />
            <Stat label="Hired in this period" value={d.hiring.hired}
              hint={d.hiring.median_days_to_hire !== null ? `${num(d.hiring.median_days_to_hire)} days from applying, typically` : <Link href="/hr/pipeline">Open the board</Link>} />
          </div>

          <ChartCard title={`Resumes received per day, ${date(d.range.from)} to ${date(d.range.to)}`} table={
            <Table rows={d.applicants_by_day} empty="No applications in this period." columns={[
              { key: 'day', title: 'Day', render: (r) => date(r.day) }, { key: 'applicants', title: 'Resumes', align: 'right' },
            ]} />
          }>
            <LineChart name="resumes" singular="resume" empty="No applications in this period."
              points={fillDays(d.applicants_by_day.map((r: any) => ({ day: r.day, value: Number(r.applicants) })), d.range.from, d.range.to)} />
          </ChartCard>

          <div className="grid">
            <ChartCard title="Where applicants come from">
              <BarList empty="No applications in this period."
                data={d.by_source.map((r: any) => ({ label: label(r.source), value: r.applicants, note: `${r.hired} hired` }))} />
            </ChartCard>

            <ChartCard title="Why applicants were rejected">
              <BarList empty="Nobody rejected in this period."
                data={d.rejections.map((r: any) => ({ label: label(r.reason), value: r.count }))} />
            </ChartCard>

            <ChartCard title="Open positions: filled so far" actions={<Link href="/hr/openings">Openings</Link>}>
              <MeterList empty="No open positions."
                data={d.openings.map((o: any) => ({ label: `${o.title} · ${o.in_progress} in progress`, value: o.hired, limit: o.positions, href: `/hr/applicants?opening_id=${o.id}` }))} />
            </ChartCard>

            <ChartCard title="People on the rolls, by department" actions={<Link href="/hr/employees">Employees</Link>}>
              <BarList empty="No employees yet."
                data={d.headcount.map((r: any) => ({ label: r.department, value: r.count }))} />
            </ChartCard>

            <ChartCard title="Attendance today" actions={<Link href="/hr/attendance">Open the register</Link>}>
              <BarList empty="No employees yet."
                data={att.on_rolls === 0 ? [] : [
                  { label: 'Present', value: att.present }, { label: 'Half day', value: att.half_day }, { label: 'Absent', value: att.absent },
                  { label: 'On leave', value: att.leave }, { label: 'Off / holiday', value: att.off }, { label: 'Not marked yet', value: att.not_marked },
                ]} />
            </ChartCard>

            <Card title="Interviews in the next 7 days">
              <Table rows={d.interviews_upcoming} empty="None booked." rowHref={(r) => `/hr/applicants/${r.applicant_id}`} columns={[
                { key: 'applicant_name', title: 'Applicant' },
                { key: 'title', title: 'Round', render: (r) => `${r.round}. ${r.title}` },
                { key: 'scheduled_at', title: 'When', render: (r) => dateTime(r.scheduled_at) },
                { key: 'interviewer_name', title: 'Interviewer' },
              ]} />
            </Card>
          </div>
        </>
      )}
    </Page>
  );
}
