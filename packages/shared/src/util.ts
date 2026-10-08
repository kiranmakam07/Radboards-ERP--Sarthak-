/**
 * Phone is the dedupe key for leads, parties and walk-ins (PRD 7.1).
 * Normalised to +91XXXXXXXXXX. Returns null when it is not a valid Indian mobile.
 */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  else if (digits.length === 13 && digits.startsWith('091')) digits = digits.slice(3);
  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return `+91${digits}`;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Calendar date (YYYY-MM-DD) in IST for a given instant. */
export function istDate(at: Date = new Date()): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Indian financial year (April-March) label for a YYYY-MM-DD date, e.g. "2026-27". */
export function fyOf(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Short FY used inside document numbers, e.g. "26-27". */
export function fyShort(date: string): string {
  const fy = fyOf(date);
  return `${fy.slice(2, 4)}-${fy.slice(5, 7)}`;
}

export function fyRange(fy: string): { from: string; to: string } {
  const start = Number(fy.slice(0, 4));
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

/** DD-MM-YYYY for display. */
export function formatDate(date: string | null | undefined): string {
  if (!date) return '';
  const d = date.slice(0, 10);
  return `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
}

export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
