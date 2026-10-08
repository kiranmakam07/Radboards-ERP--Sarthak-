import Decimal from 'decimal.js';

// All money maths goes through Decimal so 0.1 + 0.2 style float errors can never
// reach an invoice or a ledger. Values cross the wire / DB as strings ("1234.50").
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };
export type Num = string | number | Decimal;

export const D = (v: Num | null | undefined): Decimal => new Decimal(v ?? 0);

/** Round to paise (2 dp, half-up). */
export const round2 = (v: Num): Decimal => D(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
/** Round a quantity to 3 dp. */
export const round3 = (v: Num): Decimal => D(v).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);

/** Money as a DB/JSON string with exactly 2 decimals. */
export const money = (v: Num): string => round2(v).toFixed(2);
/** Quantity as a DB/JSON string with exactly 3 decimals. */
export const qty = (v: Num): string => round3(v).toFixed(3);

export const sum = (values: Num[]): Decimal => values.reduce<Decimal>((a, b) => a.plus(D(b)), D(0));

/** Indian digit grouping: 123456.5 -> "1,23,456.50". */
export function formatINR(v: Num, withSymbol = false): string {
  const d = round2(v);
  const neg = d.isNegative();
  const [intPart = '0', dec = '00'] = d.abs().toFixed(2).split('.');
  let grouped: string;
  if (intPart.length <= 3) grouped = intPart;
  else {
    const last3 = intPart.slice(-3);
    const rest = intPart.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    grouped = `${rest},${last3}`;
  }
  return `${neg ? '-' : ''}${withSymbol ? '₹' : ''}${grouped}.${dec}`;
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const t = TENS[Math.floor(n / 10)] ?? '';
  const o = ONES[n % 10] ?? '';
  return o ? `${t} ${o}` : t;
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (rest) parts.push(twoDigits(rest));
  return parts.join(' ');
}

function integerInWords(n: number): string {
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (crore) parts.push(`${integerInWords(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));
  return parts.join(' ');
}

/** "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only" */
export function amountInWords(v: Num): string {
  const d = round2(v).abs();
  const rupees = d.floor().toNumber();
  const paise = d.minus(d.floor()).times(100).toDecimalPlaces(0).toNumber();
  let out = `Rupees ${integerInWords(rupees)}`;
  if (paise) out += ` and ${twoDigits(paise)} Paise`;
  return `${out} Only`;
}
