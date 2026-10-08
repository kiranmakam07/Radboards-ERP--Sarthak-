import { D, Decimal, round2, type Num } from './money';

/** GST state codes (first two digits of a GSTIN). */
export const STATE_CODES: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura',
  '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha',
  '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu',
  '34': 'Puducherry', '35': 'Andaman & Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh', '97': 'Other Territory',
};

export const GST_RATES = [0, 5, 12, 18, 28] as const;

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Check character for the first 14 characters of a GSTIN (Luhn mod 36). */
export function gstinCheckChar(first14: string): string {
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const value = B36.indexOf(first14[i] ?? '');
    const product = value * (i % 2 === 0 ? 1 : 2);
    total += Math.floor(product / 36) + (product % 36);
  }
  return B36[(36 - (total % 36)) % 36] ?? '';
}

export function normaliseGstin(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

/** Format, state code and checksum validation. */
export function isValidGstin(raw: string): boolean {
  const g = normaliseGstin(raw);
  if (!GSTIN_RE.test(g)) return false;
  if (!STATE_CODES[g.slice(0, 2)]) return false;
  return gstinCheckChar(g.slice(0, 14)) === g[14];
}

export function stateCodeFromGstin(raw: string): string | null {
  const g = normaliseGstin(raw);
  return isValidGstin(g) ? g.slice(0, 2) : null;
}

export type TaxSplit = { cgst: Decimal; sgst: Decimal; igst: Decimal };

/**
 * THE place-of-supply rule (PRD 7.9). Same state as the company -> CGST + SGST,
 * different state -> IGST. Every document goes through this one function.
 */
export function isInterState(companyStateCode: string, placeOfSupply: string): boolean {
  return companyStateCode !== placeOfSupply;
}

export function splitTax(totalTax: Num, interState: boolean): TaxSplit {
  const tax = round2(totalTax);
  if (interState) return { cgst: D(0), sgst: D(0), igst: tax };
  // Halve, and give any odd paisa to neither: CGST and SGST must be equal by law,
  // so we round each half and let the line total follow.
  const half = round2(tax.div(2));
  return { cgst: half, sgst: half, igst: D(0) };
}

export type LineInput = {
  qty: Num;
  rate: Num;
  /** Absolute discount on the line (same tax basis as rate). */
  discount?: Num;
  gstRate: Num;
};

export type LineTax = {
  taxableValue: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
  lineTotal: Decimal;
};

/**
 * Tax for one document line.
 * - Exclusive pricing: taxable = qty*rate - discount; tax is added on top.
 * - Inclusive pricing (retail/MRP): gross = qty*rate - discount; taxable is backed out.
 */
export function computeLine(line: LineInput, interState: boolean, taxInclusive = false): LineTax {
  const gross = round2(D(line.qty).times(D(line.rate)).minus(D(line.discount ?? 0)));
  const rate = D(line.gstRate);
  let taxable: Decimal;
  if (taxInclusive) taxable = round2(gross.times(100).div(rate.plus(100)));
  else taxable = gross;

  let split: TaxSplit;
  if (interState) {
    split = { cgst: D(0), sgst: D(0), igst: round2(taxable.times(rate).div(100)) };
  } else {
    const half = round2(taxable.times(rate).div(200));
    split = { cgst: half, sgst: half, igst: D(0) };
  }
  if (taxInclusive) {
    // Keep the customer-facing gross exact: absorb the rounding paisa into taxable value.
    const tax = split.cgst.plus(split.sgst).plus(split.igst);
    taxable = gross.minus(tax);
  }
  const lineTotal = taxable.plus(split.cgst).plus(split.sgst).plus(split.igst);
  return { taxableValue: taxable, ...split, lineTotal };
}

export type DocTotals = {
  taxableTotal: Decimal;
  cgstTotal: Decimal;
  sgstTotal: Decimal;
  igstTotal: Decimal;
  roundOff: Decimal;
  grandTotal: Decimal;
};

/** Sum lines and round the grand total to the nearest rupee (round_off holds the difference). */
export function computeTotals(lines: LineTax[], roundToRupee = true): DocTotals {
  const zero = D(0);
  const taxableTotal = lines.reduce((a, l) => a.plus(l.taxableValue), zero);
  const cgstTotal = lines.reduce((a, l) => a.plus(l.cgst), zero);
  const sgstTotal = lines.reduce((a, l) => a.plus(l.sgst), zero);
  const igstTotal = lines.reduce((a, l) => a.plus(l.igst), zero);
  const raw = taxableTotal.plus(cgstTotal).plus(sgstTotal).plus(igstTotal);
  const grandTotal = roundToRupee ? raw.toDecimalPlaces(0, Decimal.ROUND_HALF_UP) : raw;
  return { taxableTotal, cgstTotal, sgstTotal, igstTotal, roundOff: grandTotal.minus(raw), grandTotal };
}
