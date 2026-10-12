import { D, money } from './money';

/**
 * How a month's salary is worked out. The figures are the ones in general use in India and can
 * be changed under Payroll > Rules; whether PF and ESIC apply to a person at all is set on that
 * person, because it depends on how the company is registered.
 * - Basic is a share of the salary; the rest is allowances. PF is charged on Basic, up to a ceiling.
 * - ESIC is charged on the whole salary earned, and only for someone whose monthly salary is at or
 *   under the limit.
 * - Professional tax and TDS are an amount per month set on the person.
 */
export type PayrollRules = {
  basic_pct: number;
  pf_rate: number;
  pf_wage_ceiling: number;
  esic_employee_rate: number;
  esic_employer_rate: number;
  esic_gross_limit: number;
};

export const PAYROLL_RULES_DEFAULT: PayrollRules = {
  basic_pct: 50, pf_rate: 12, pf_wage_ceiling: 15000, esic_employee_rate: 0.75, esic_employer_rate: 3.25, esic_gross_limit: 21000,
};

export type PayInput = {
  monthlySalary: string | number;
  daysInMonth: number;
  /** Days paid for: worked, paid leave, weekly offs and holidays. Half days count as half. */
  paidDays: number;
  pf: boolean;
  esic: boolean;
  ptMonthly: string | number;
  tdsMonthly: string | number;
  /** A bonus or arrears added this month, and a fine or other amount taken off. */
  otherEarning: string | number;
  otherDeduction: string | number;
  /** What is due this month against advances the person has taken. */
  advanceDue: string | number;
};

export type Pay = {
  grossEarned: string; basicEarned: string; allowanceEarned: string;
  pfEmployee: string; pfEmployer: string; esicEmployee: string; esicEmployer: string;
  pt: string; tds: string; advanceRecovery: string; netPay: string;
};

export function computePay(input: PayInput, rules: PayrollRules = PAYROLL_RULES_DEFAULT): Pay {
  const salary = D(input.monthlySalary);
  const paidDays = Math.max(0, Math.min(input.paidDays, input.daysInMonth));
  const gross = input.daysInMonth > 0 ? salary.times(paidDays).div(input.daysInMonth).toDecimalPlaces(2) : D(0);
  const basic = gross.times(rules.basic_pct).div(100).toDecimalPlaces(2);
  // PF is rounded to the nearest rupee; ESIC is rounded up to the next rupee.
  const pfWage = D(Math.min(basic.toNumber(), rules.pf_wage_ceiling));
  const pf = input.pf ? pfWage.times(rules.pf_rate).div(100).toDecimalPlaces(0) : D(0);
  const covered = input.esic && salary.lte(rules.esic_gross_limit);
  const esicEmployee = covered ? gross.times(rules.esic_employee_rate).div(100).ceil() : D(0);
  const esicEmployer = covered ? gross.times(rules.esic_employer_rate).div(100).ceil() : D(0);
  const earned = gross.gt(0);
  const pt = earned ? D(input.ptMonthly) : D(0);
  const tds = earned ? D(input.tdsMonthly) : D(0);
  // An advance is recovered only out of what is left after everything else, never beyond it.
  const beforeAdvance = gross.plus(input.otherEarning).minus(input.otherDeduction).minus(pf).minus(esicEmployee).minus(pt).minus(tds);
  const advance = beforeAdvance.gt(0) ? (D(input.advanceDue).lt(beforeAdvance) ? D(input.advanceDue) : beforeAdvance) : D(0);
  return {
    grossEarned: money(gross), basicEarned: money(basic), allowanceEarned: money(gross.minus(basic)),
    pfEmployee: money(pf), pfEmployer: money(pf), esicEmployee: money(esicEmployee), esicEmployer: money(esicEmployer),
    pt: money(pt), tds: money(tds), advanceRecovery: money(advance), netPay: money(beforeAdvance.minus(advance)),
  };
}
