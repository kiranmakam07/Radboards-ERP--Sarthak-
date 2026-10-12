'use client';

import { date, inr, num } from '@/components/ui';

const addr = (a: any) => (a ? [a.line1, a.line2, a.city, a.state, a.pincode].filter(Boolean).join(', ') : '');

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
