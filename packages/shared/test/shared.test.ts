import { describe, expect, it } from 'vitest';
import {
  PAYROLL_RULES_DEFAULT, ROLES, addMonths, amountInWords, canMoveApplicant, canMoveLead, computeLine, computePay, computeTotals, formatINR, fyOf, fyShort, gstinCheckChar,
  isInterState, isTaskDueOn, isValidGstin, leaveEntitlement, money, normalisePhone, peakLoad, stateCodeFromGstin, can, weekStart, weekdayOf,
} from '../src';

describe('money', () => {
  it('formats with Indian digit grouping', () => {
    expect(formatINR(123456)).toBe('1,23,456.00');
    expect(formatINR('12345678.5')).toBe('1,23,45,678.50');
    expect(formatINR(999)).toBe('999.00');
    expect(formatINR(-1500.255)).toBe('-1,500.26');
  });
  it('rounds half-up to paise without float drift', () => {
    expect(money(0.1 + 0.2)).toBe('0.30');
    expect(money('1.005')).toBe('1.01');
    expect(money('2.675')).toBe('2.68');
  });
  it('writes amounts in words (Indian system)', () => {
    expect(amountInWords(123456.5)).toBe(
      'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only',
    );
    expect(amountInWords(10000000)).toBe('Rupees One Crore Only');
    expect(amountInWords(0)).toBe('Rupees Zero Only');
    expect(amountInWords(1180)).toBe('Rupees One Thousand One Hundred Eighty Only');
  });
});

describe('GSTIN', () => {
  it('validates format, state and checksum', () => {
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true);
    expect(isValidGstin('27aapfu0939f1zv')).toBe(true);
    expect(isValidGstin('27AAPFU0939F1ZX')).toBe(false); // bad check digit
    expect(isValidGstin('99AAPFU0939F1ZV')).toBe(false); // bad state
    expect(isValidGstin('27AAPFU0939F1')).toBe(false);
  });
  it('reads the state code', () => {
    expect(stateCodeFromGstin('27AAPFU0939F1ZV')).toBe('27');
    expect(stateCodeFromGstin('garbage')).toBeNull();
  });
  it('computes the check character', () => {
    expect(gstinCheckChar('27AAPFU0939F1Z')).toBe('V');
  });
});

describe('GST split (place of supply)', () => {
  it('same state -> CGST + SGST', () => {
    const l = computeLine({ qty: 2, rate: 1000, gstRate: 18 }, isInterState('27', '27'));
    expect(l.taxableValue.toFixed(2)).toBe('2000.00');
    expect(l.cgst.toFixed(2)).toBe('180.00');
    expect(l.sgst.toFixed(2)).toBe('180.00');
    expect(l.igst.toFixed(2)).toBe('0.00');
    expect(l.lineTotal.toFixed(2)).toBe('2360.00');
  });
  it('different state -> IGST', () => {
    const l = computeLine({ qty: 2, rate: 1000, gstRate: 18 }, isInterState('27', '29'));
    expect(l.cgst.toFixed(2)).toBe('0.00');
    expect(l.igst.toFixed(2)).toBe('360.00');
    expect(l.lineTotal.toFixed(2)).toBe('2360.00');
  });
  it('applies line discount before tax', () => {
    const l = computeLine({ qty: 1, rate: 1000, discount: 100, gstRate: 12 }, false);
    expect(l.taxableValue.toFixed(2)).toBe('900.00');
    expect(l.cgst.toFixed(2)).toBe('54.00');
    expect(l.lineTotal.toFixed(2)).toBe('1008.00');
  });
  it('tax-inclusive pricing keeps the gross exact', () => {
    const a = computeLine({ qty: 1, rate: 1180, gstRate: 18 }, false, true);
    expect(a.taxableValue.toFixed(2)).toBe('1000.00');
    expect(a.lineTotal.toFixed(2)).toBe('1180.00');
    const b = computeLine({ qty: 1, rate: 999, gstRate: 18 }, false, true);
    expect(b.lineTotal.toFixed(2)).toBe('999.00');
    expect(b.cgst.eq(b.sgst)).toBe(true);
    const c = computeLine({ qty: 3, rate: 333.33, gstRate: 28 }, true, true);
    expect(c.lineTotal.toFixed(2)).toBe('999.99');
    expect(c.taxableValue.plus(c.igst).toFixed(2)).toBe('999.99');
  });
  it('0% items carry no tax', () => {
    const l = computeLine({ qty: 5, rate: 10, gstRate: 0 }, false);
    expect(l.lineTotal.toFixed(2)).toBe('50.00');
  });
  it('rounds the grand total to the rupee and reports round-off', () => {
    const lines = [
      computeLine({ qty: 1, rate: 99.5, gstRate: 5 }, false), // 99.50 + 2.49 + 2.49 = 104.48
      computeLine({ qty: 1, rate: 10.1, gstRate: 18 }, false), // 10.10 + 0.91 + 0.91 = 11.92
    ];
    const t = computeTotals(lines);
    expect(t.taxableTotal.toFixed(2)).toBe('109.60');
    expect(t.grandTotal.toFixed(2)).toBe('116.00');
    expect(t.roundOff.toFixed(2)).toBe('-0.40');
    expect(
      t.taxableTotal.plus(t.cgstTotal).plus(t.sgstTotal).plus(t.igstTotal).plus(t.roundOff).eq(t.grandTotal),
    ).toBe(true);
  });
});

describe('phone', () => {
  it('normalises to +91XXXXXXXXXX', () => {
    expect(normalisePhone('98765 43210')).toBe('+919876543210');
    expect(normalisePhone('+91-98765-43210')).toBe('+919876543210');
    expect(normalisePhone('09876543210')).toBe('+919876543210');
    expect(normalisePhone('919876543210')).toBe('+919876543210');
  });
  it('rejects invalid numbers', () => {
    expect(normalisePhone('12345')).toBeNull();
    expect(normalisePhone('1234567890')).toBeNull(); // must start 6-9
    expect(normalisePhone('')).toBeNull();
  });
});

describe('financial year', () => {
  it('runs April to March', () => {
    expect(fyOf('2026-10-08')).toBe('2026-27');
    expect(fyOf('2027-03-31')).toBe('2026-27');
    expect(fyOf('2027-04-01')).toBe('2027-28');
    expect(fyShort('2026-10-08')).toBe('26-27');
    expect(fyOf('1999-12-01')).toBe('1999-00');
  });
});

describe('state machine + permissions', () => {
  it('follows the lead stage machine', () => {
    expect(canMoveLead('new', 'converted')).toBe(true);
    expect(canMoveLead('converted', 'contacted')).toBe(false);
    expect(canMoveLead('lost', 'contacted')).toBe(true);
    expect(canMoveLead('lost', 'interested')).toBe(false);
    expect(canMoveLead('contacted', 'new')).toBe(false);
  });
  it('enforces least-privilege roles', () => {
    expect(can('store', 'quickbill:create')).toBe(true);
    expect(can('store', 'accounts:write')).toBe(false);
    expect(can('marketing', 'payments:read')).toBe(false);
    expect(can('admin', 'accounts:write')).toBe(true);
    expect(can('owner', 'stock:approve')).toBe(true);
  });
});

describe('HR and operations', () => {
  it('follows the applicant stage machine', () => {
    expect(canMoveApplicant('applied', 'interview')).toBe(true);
    expect(canMoveApplicant('applied', 'hired')).toBe(false);
    expect(canMoveApplicant('interview', 'hired')).toBe(false);
    expect(canMoveApplicant('offered', 'hired')).toBe(true);
    expect(canMoveApplicant('hired', 'rejected')).toBe(false);
    expect(canMoveApplicant('rejected', 'shortlisted')).toBe(true);
  });
  it('keeps HR and operations to their own roles, and existing roles in their old positions', () => {
    expect(ROLES.slice(0, 7)).toEqual(['owner', 'marketing', 'store', 'sales', 'stores', 'accounts', 'admin']);
    expect(can('hr', 'hr:write')).toBe(true);
    expect(can('owner', 'hr:read')).toBe(true);
    expect(can('owner', 'hr:write')).toBe(false);
    expect(can('sales', 'hr:read')).toBe(false);
    expect(can('hr', 'accounts:read')).toBe(false);
    expect(can('operations', 'ops:manage')).toBe(true);
    expect(can('stores', 'ops:manage')).toBe(false);
  });
  it('adds calendar months, landing on the last day when the month is shorter', () => {
    expect(addMonths('2026-10-09', 6)).toBe('2027-04-09');
    expect(addMonths('2026-08-31', 6)).toBe('2027-02-28');
    expect(addMonths('2027-08-31', 6)).toBe('2028-02-29');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
  });
  it('knows which days a recurring task falls on', () => {
    expect(weekdayOf('2026-10-09')).toBe(5); // a Friday
    const monToSat = { frequency: 'daily' as const, weekdays: [1, 2, 3, 4, 5, 6], monthDay: null };
    expect(isTaskDueOn(monToSat, '2026-10-10')).toBe(true); // Saturday
    expect(isTaskDueOn(monToSat, '2026-10-11')).toBe(false); // Sunday
    const everyMonday = { frequency: 'weekly' as const, weekdays: [1], monthDay: null };
    expect(isTaskDueOn(everyMonday, '2026-10-12')).toBe(true);
    expect(isTaskDueOn(everyMonday, '2026-10-13')).toBe(false);
    const monthEnd = { frequency: 'monthly' as const, weekdays: [], monthDay: 31 };
    expect(isTaskDueOn(monthEnd, '2026-10-31')).toBe(true);
    expect(isTaskDueOn(monthEnd, '2026-11-30')).toBe(true); // November has no 31st
    expect(isTaskDueOn(monthEnd, '2026-11-29')).toBe(false);
    expect(isTaskDueOn({ frequency: 'monthly', weekdays: [], monthDay: 5 }, '2026-11-05')).toBe(true);
    expect(isTaskDueOn({ frequency: 'need_based', weekdays: [1], monthDay: 1 }, '2026-11-02')).toBe(false);
  });
  it('finds the busiest day of a set of allocations', () => {
    const spans = [
      { from: '2026-10-05', to: '2026-10-16', percent: 50 },
      { from: '2026-10-12', to: '2026-10-23', percent: 40 },
      { from: '2026-10-14', to: '2026-10-14', percent: 30 },
    ];
    expect(peakLoad(spans, '2026-10-05', '2026-10-11')).toBe(50);
    expect(peakLoad(spans, '2026-10-12', '2026-10-18')).toBe(120); // the 14th: all three overlap
    expect(peakLoad(spans, '2026-10-15', '2026-10-18')).toBe(90);
    expect(peakLoad(spans, '2026-10-19', '2026-10-25')).toBe(40);
    expect(peakLoad(spans, '2026-11-01', '2026-11-07')).toBe(0);
    expect(peakLoad([], '2026-10-05', '2026-10-11')).toBe(0);
    expect(weekStart('2026-10-09')).toBe('2026-10-05'); // Friday -> Monday
    expect(weekStart('2026-10-11')).toBe('2026-10-05'); // Sunday belongs to the week that started on Monday
    expect(weekStart('2026-10-12')).toBe('2026-10-12');
  });
  it('gives a part-year joiner leave in proportion to the months left', () => {
    const year = { from: '2026-04-01', to: '2027-03-31' };
    expect(leaveEntitlement(12, '2024-06-01', year)).toBe(12); // here all year
    expect(leaveEntitlement(12, '2026-04-01', year)).toBe(12);
    expect(leaveEntitlement(12, '2026-10-15', year)).toBe(6); // October to March
    expect(leaveEntitlement(12, '2027-03-31', year)).toBe(1); // the joining month counts
    expect(leaveEntitlement(15, '2027-01-01', year)).toBe(4); // 3.75, to the nearest half
    expect(leaveEntitlement(18, '2027-01-10', year)).toBe(4.5);
    expect(leaveEntitlement(12, '2027-04-01', year)).toBe(0); // joins after the year ends
  });
});

describe('salary for a month', () => {
  const base = { monthlySalary: 30000, daysInMonth: 30, paidDays: 30, pf: false, esic: false, ptMonthly: 0, tdsMonthly: 0, otherEarning: 0, otherDeduction: 0, advanceDue: 0 };

  it('pays the whole salary for a whole month, and in proportion for part of one', () => {
    expect(computePay(base)).toMatchObject({ grossEarned: '30000.00', basicEarned: '15000.00', allowanceEarned: '15000.00', netPay: '30000.00' });
    // 27 paid days out of 31: 30,000 x 27 / 31 = 26,129.03
    expect(computePay({ ...base, daysInMonth: 31, paidDays: 27 })).toMatchObject({ grossEarned: '26129.03', netPay: '26129.03' });
    expect(computePay({ ...base, paidDays: 0 })).toMatchObject({ grossEarned: '0.00', netPay: '0.00' });
    expect(computePay({ ...base, paidDays: 40 }).grossEarned).toBe('30000.00'); // never more than the month
  });

  it('takes PF on Basic up to the ceiling, the same again from the employer', () => {
    // Basic 15,000 at 12% = 1,800.
    expect(computePay({ ...base, pf: true })).toMatchObject({ pfEmployee: '1800.00', pfEmployer: '1800.00', netPay: '28200.00' });
    // Salary 50,000: Basic 25,000, but PF only on the first 15,000.
    expect(computePay({ ...base, monthlySalary: 50000, pf: true }).pfEmployee).toBe('1800.00');
    // Half a month on 20,000: Basic earned 5,000 at 12% = 600.
    expect(computePay({ ...base, monthlySalary: 20000, paidDays: 15, pf: true })).toMatchObject({ grossEarned: '10000.00', pfEmployee: '600.00', netPay: '9400.00' });
  });

  it('takes ESIC on what was earned, only for a salary within the limit, rounded up to the rupee', () => {
    // 18,000 earned: 0.75% = 135, employer 3.25% = 585.
    expect(computePay({ ...base, monthlySalary: 18000, esic: true })).toMatchObject({ esicEmployee: '135.00', esicEmployer: '585.00', netPay: '17865.00' });
    // 18,000 x 29 / 31 = 16,838.71: 0.75% = 126.29, so 127.
    expect(computePay({ ...base, monthlySalary: 18000, daysInMonth: 31, paidDays: 29, esic: true }).esicEmployee).toBe('127.00');
    // Over 21,000 a month: not covered, even when switched on.
    expect(computePay({ ...base, monthlySalary: 21001, esic: true }).esicEmployee).toBe('0.00');
    expect(computePay({ ...base, monthlySalary: 21000, esic: true }).esicEmployee).toBe('158.00'); // 157.50 rounded up
  });

  it('takes professional tax and TDS as set, adds a bonus, takes off a fine, and recovers an advance from what is left', () => {
    const pay = computePay({ ...base, pf: true, ptMonthly: 200, tdsMonthly: 500, otherEarning: 1000, otherDeduction: 250, advanceDue: 5000 });
    // 30,000 + 1,000 - 250 - 1,800 PF - 200 PT - 500 TDS = 28,250; less the 5,000 advance = 23,250.
    expect(pay).toMatchObject({ pt: '200.00', tds: '500.00', advanceRecovery: '5000.00', netPay: '23250.00' });
    // The advance never takes more than there is.
    expect(computePay({ ...base, monthlySalary: 6000, paidDays: 10, advanceDue: 5000 })).toMatchObject({ grossEarned: '2000.00', advanceRecovery: '2000.00', netPay: '0.00' });
    // Nothing earned, nothing deducted.
    expect(computePay({ ...base, paidDays: 0, ptMonthly: 200, tdsMonthly: 500, advanceDue: 5000 })).toMatchObject({ pt: '0.00', tds: '0.00', advanceRecovery: '0.00', netPay: '0.00' });
  });

  it('follows the rules when they are changed', () => {
    const rules = { ...PAYROLL_RULES_DEFAULT, basic_pct: 40, pf_wage_ceiling: 100000 };
    expect(computePay({ ...base, pf: true }, rules)).toMatchObject({ basicEarned: '12000.00', allowanceEarned: '18000.00', pfEmployee: '1440.00' });
  });
});
