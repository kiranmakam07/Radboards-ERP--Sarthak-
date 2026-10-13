import { D, Decimal, type Num } from './money';

/** PAN checks and the arithmetic of tax deducted at source. Which rates apply is data, kept in the tds_rates table. */

/** A PAN is five letters, four digits and a letter (ABCDE1234F). */
export const normalisePan = (pan: string): string => pan.replace(/\s+/g, '').toUpperCase();
export const isValidPan = (pan: string): boolean => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(normalisePan(pan));

/** The PAN inside a GSTIN: its third to twelfth characters. */
export const panFromGstin = (gstin: string | null | undefined): string | null => {
  const pan = gstin ? normalisePan(gstin).slice(2, 12) : '';
  return isValidPan(pan) ? pan : null;
};

/**
 * Tax to hold back from a payment: the rate applied to the amount before GST, to the nearest
 * rupee (fifty paise and above goes up). This is the figure offered on screen; the person
 * paying can enter a different one when a lower-deduction certificate applies.
 */
export function tdsOn(base: Num, ratePct: Num): string {
  return D(base).times(D(ratePct)).div(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(2);
}

/** The quarter of the financial year a date falls in, for the TDS return: Q1 is April to June. */
export function tdsQuarter(date: string): { fy: string; quarter: 1 | 2 | 3 | 4; from: string; to: string } {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const start = month >= 4 ? year : year - 1;
  const quarter = (month >= 4 ? Math.floor((month - 4) / 3) + 1 : 4) as 1 | 2 | 3 | 4;
  const firstMonth = quarter === 4 ? 1 : 4 + (quarter - 1) * 3;
  const y = quarter === 4 ? start + 1 : start;
  const lastDay = new Date(Date.UTC(y, firstMonth + 2, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    fy: `${start}-${String(start + 1).slice(2)}`, quarter,
    from: `${y}-${pad(firstMonth)}-01`, to: `${y}-${pad(firstMonth + 2)}-${pad(lastDay)}`,
  };
}
