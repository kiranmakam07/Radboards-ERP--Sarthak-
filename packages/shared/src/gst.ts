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

const STATE_SHORT: Record<string, string> = {
  JK: '01', HP: '02', PB: '03', CH: '04', UK: '05', UT: '05', UA: '05', HR: '06', DL: '07', RJ: '08', UP: '09', BR: '10', SK: '11',
  AR: '12', NL: '13', MN: '14', MZ: '15', TR: '16', ML: '17', AS: '18', WB: '19', JH: '20', OR: '21', OD: '21', CG: '22', CT: '22',
  MP: '23', GJ: '24', DN: '26', DD: '26', DH: '26', MH: '27', KA: '29', GA: '30', LD: '31', KL: '32', TN: '33', PY: '34', AN: '35',
  TS: '36', TG: '36', AP: '37', LA: '38',
};
const lettersOnly = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
const STATE_BY_NAME: Record<string, string> = {
  ...Object.fromEntries(Object.entries(STATE_CODES).map(([code, name]) => [lettersOnly(name), code])),
  orissa: '21', pondicherry: '34', uttaranchal: '05', newdelhi: '07', nctofdelhi: '07', jammukashmir: '01',
  andamanandnicobar: '35', dadraandnagarhaveli: '26', damananddiu: '26', chattisgarh: '22',
};

/**
 * The GST state code for a state as other systems write it: its name ("Karnataka"), its short
 * code ("KA", "IN-KA") or the GST code itself ("29"). Null when it is none of these.
 */
export function stateCodeFor(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  if (/^\d{1,2}$/.test(text)) return STATE_CODES[text.padStart(2, '0')] ? text.padStart(2, '0') : null;
  const short = text.toUpperCase().replace(/^IN-/, '');
  if (/^[A-Z]{2}$/.test(short) && STATE_SHORT[short]) return STATE_SHORT[short]!;
  return STATE_BY_NAME[lettersOnly(text)] ?? null;
}
