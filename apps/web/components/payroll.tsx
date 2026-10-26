'use client';

import { istDate } from '@radcore/shared';
import { useState } from 'react';
import { ErrorBox, addr, date, inr, num } from '@/components/ui';
import { put } from '@/lib/api';

/**
 * A payslip as a document: what was earned, what was taken off and why, and what is paid. The same
 * component draws it for payroll, for the person on "My work", and for the link sent to them.
 */
export function PayslipDocument({ slip }: { slip: any }) {
  const c = slip.company;
  const earnings: [string, string][] = [['Basic', slip.basic_earned], ['Allowances', slip.allowance_earned]];
  if (Number(slip.other_earning)) earnings.push([slip.note || 'Addition', slip.other_earning]);
  const deductions: [string, string][] = [];
  if (Number(slip.pf_employee)) deductions.push(['Provident fund', slip.pf_employee]);
  if (Number(slip.esic_employee)) deductions.push(['ESIC', slip.esic_employee]);
  if (Number(slip.pt)) deductions.push(['Professional tax', slip.pt]);
  if (Number(slip.tds)) deductions.push(['Income tax (TDS)', slip.tds]);
  if (Number(slip.advance_recovery)) deductions.push(['Advance taken back', slip.advance_recovery]);
  if (Number(slip.other_deduction)) deductions.push([slip.note || 'Deduction', slip.other_deduction]);
  const lines = Math.max(earnings.length, deductions.length);

  return (
    <div className="doc">
      <h1>PAYSLIP · {String(slip.month_name).toUpperCase()}</h1>
      <div className="head">
        <div>
          <strong>{c.name}</strong><br />
          {addr(c.address)}
        </div>
        <div>
          <strong>{slip.employee_name}</strong> ({slip.employee_no})<br />
          {slip.designation}, {slip.department}<br />
          {slip.bank_account_no ? <>Bank account: {slip.bank_account_no}{slip.bank_ifsc ? ` · ${slip.bank_ifsc}` : ''}<br /></> : null}
          {slip.run_status === 'paid' && slip.paid_on ? <>Paid on {date(slip.paid_on)}</> : slip.run_status === 'draft' ? <strong>DRAFT: may still change</strong> : null}
        </div>
      </div>
      <p className="small">
        Monthly salary ₹{inr(slip.monthly_salary)} · paid for <strong>{num(slip.paid_days)}</strong> of {slip.days_in_month} days
        {' '}({slip.present} present{slip.half_days ? `, ${slip.half_days} half` : ''}{slip.leave_days ? `, ${slip.leave_days} leave` : ''}
        {slip.weekly_off ? `, ${slip.weekly_off} weekly off` : ''}{slip.holidays ? `, ${slip.holidays} holiday` : ''}
        {slip.absent ? `, ${slip.absent} absent` : ''}{slip.not_marked ? `, ${slip.not_marked} not marked` : ''})
        {Number(slip.unpaid_leave) ? <><br />{num(slip.unpaid_leave)} day{Number(slip.unpaid_leave) === 1 ? '' : 's'} of leave beyond the year&apos;s allowance, not paid.</> : null}
      </p>
      <table>
        <thead><tr><th>Earnings</th><th className="right">₹</th><th>Deductions</th><th className="right">₹</th></tr></thead>
        <tbody>
          {Array.from({ length: lines }, (_, i) => (
            <tr key={i}>
              <td>{earnings[i]?.[0] ?? ''}</td><td className="right">{earnings[i] ? inr(earnings[i]![1]) : ''}</td>
              <td>{deductions[i]?.[0] ?? ''}</td><td className="right">{deductions[i] ? inr(deductions[i]![1]) : ''}</td>
            </tr>
          ))}
          <tr>
            <td><strong>Total earned</strong></td><td className="right"><strong>{inr(slip.total_earnings)}</strong></td>
            <td><strong>Total taken off</strong></td><td className="right"><strong>{inr(slip.total_deductions)}</strong></td>
          </tr>
        </tbody>
      </table>
      <div className="totals" style={{ marginTop: 10 }}>
        <div className="grand"><span>Net pay</span><span>₹{inr(slip.net_pay)}</span></div>
      </div>
      <p className="words">{slip.net_in_words}</p>
      {Number(slip.pf_employer) || Number(slip.esic_employer) ? (
        <p className="small muted">
          Paid by the company on top of this: {Number(slip.pf_employer) ? `provident fund ₹${inr(slip.pf_employer)}` : ''}
          {Number(slip.pf_employer) && Number(slip.esic_employer) ? ', ' : ''}{Number(slip.esic_employer) ? `ESIC ₹${inr(slip.esic_employer)}` : ''}.
        </p>
      ) : null}
      <p className="small muted">This payslip is produced by the system and needs no signature.</p>
    </div>
  );
}

/** One person's salary, deductions and bank account, edited in place. Part of the employee master. */
export function PayDetails({ person, onDone }: { person: any; onDone: () => void }) {
  const [v, setV] = useState({
    monthly_salary: person.monthly_salary ?? '', salary_from: istDate(), pf_applicable: person.pf_applicable, esic_applicable: person.esic_applicable,
    pt_monthly: Number(person.pt_monthly) ? person.pt_monthly : '', tds_monthly: Number(person.tds_monthly) ? person.tds_monthly : '',
    bank_account_no: person.bank_account_no ?? '', bank_ifsc: person.bank_ifsc ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await put(`/payroll/staff/${person.id}`, { ...v, monthly_salary: v.monthly_salary === '' ? null : v.monthly_salary, pt_monthly: v.pt_monthly || 0, tds_monthly: v.tds_monthly || 0 });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="toggle-body" style={{ marginBottom: 12 }}>
      <div className="card-head"><h2>Pay details: {person.name}</h2><button type="button" onClick={onDone}>× Close</button></div>
      <div className="form">
        <label>Monthly salary ₹<input type="number" inputMode="decimal" min="0" value={v.monthly_salary} onChange={(e) => setV({ ...v, monthly_salary: e.target.value })} /></label>
        {/* A changed salary runs from this day; months before it keep the salary they had. The first salary runs from joining. */}
        {String(v.monthly_salary) !== String(person.monthly_salary ?? '') && person.monthly_salary ? (
          <label>New salary from<input type="date" value={v.salary_from} onChange={(e) => setV({ ...v, salary_from: e.target.value })} /></label>
        ) : null}
        <label className="check"><input type="checkbox" checked={v.pf_applicable} onChange={(e) => setV({ ...v, pf_applicable: e.target.checked })} /> Provident fund is deducted</label>
        <label className="check"><input type="checkbox" checked={v.esic_applicable} onChange={(e) => setV({ ...v, esic_applicable: e.target.checked })} /> ESIC is deducted</label>
        <label>Professional tax a month ₹<input type="number" inputMode="decimal" min="0" value={v.pt_monthly} placeholder="0" onChange={(e) => setV({ ...v, pt_monthly: e.target.value })} /></label>
        <label>Income tax (TDS) a month ₹<input type="number" inputMode="decimal" min="0" value={v.tds_monthly} placeholder="0" onChange={(e) => setV({ ...v, tds_monthly: e.target.value })} /></label>
        <label>Bank account number<input inputMode="numeric" value={v.bank_account_no} onChange={(e) => setV({ ...v, bank_account_no: e.target.value })} /></label>
        <label>IFSC<input value={v.bank_ifsc} placeholder="e.g. HDFC0001234" onChange={(e) => setV({ ...v, bank_ifsc: e.target.value })} /></label>
        <div className="form-foot"><button type="button" className="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div>
      </div>
      <ErrorBox error={error} />
    </div>
  );
}
