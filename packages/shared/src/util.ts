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

/** Day of the week for a YYYY-MM-DD date: 0 = Sunday ... 6 = Saturday. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function lastDayOfMonth(date: string): number {
  return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();
}

/** Add calendar months. The day is kept when the month has it, otherwise the month's last day: 31 Aug + 6 months = 28 Feb. */
export function addMonths(date: string, months: number): string {
  const total = Number(date.slice(0, 4)) * 12 + (Number(date.slice(5, 7)) - 1) + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  const first = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  const day = Math.min(Number(date.slice(8, 10)), lastDayOfMonth(first));
  return `${first.slice(0, 8)}${String(day).padStart(2, '0')}`;
}

export type TaskRule = { frequency: 'daily' | 'weekly' | 'monthly' | 'need_based'; weekdays: number[]; monthDay: number | null };

/**
 * Does a recurring task fall on this date? Daily and weekly tasks list the weekdays they run on.
 * A monthly task set for the 29th to the 31st runs on the last day of a shorter month, so it is never skipped.
 * Need-based tasks have no schedule: someone raises them when they are needed.
 */
export function isTaskDueOn(rule: TaskRule, date: string): boolean {
  if (rule.frequency === 'need_based') return false;
  if (rule.frequency === 'monthly') {
    if (!rule.monthDay) return false;
    return Number(date.slice(8, 10)) === Math.min(rule.monthDay, lastDayOfMonth(date));
  }
  return rule.weekdays.includes(weekdayOf(date));
}

/** The Monday of the week a date falls in. */
export function weekStart(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

export type Span = { from: string; to: string; percent: number };

/**
 * Resource allocation: the highest total share (in percent) that a set of allocations adds up to
 * on any single day between `from` and `to`. Over 100 means the person or machine is double-booked.
 */
export function peakLoad(spans: Span[], from: string, to: string): number {
  // The total only ever rises on a day an allocation starts, so those are the only days worth checking.
  const days = new Set<string>([from]);
  for (const s of spans) if (s.from > from && s.from <= to) days.add(s.from);
  let peak = 0;
  for (const day of days) {
    let total = 0;
    for (const s of spans) if (s.from <= day && s.to >= day) total += s.percent;
    if (total > peak) peak = total;
  }
  return peak;
}

/**
 * Leave a person is entitled to in a leave year (the financial year). Someone who joined part-way
 * through gets it in proportion to the months left, counting the month they joined, to the nearest half day.
 */
export function leaveEntitlement(daysPerYear: number, joinDate: string, year: { from: string; to: string }): number {
  if (joinDate <= year.from) return daysPerYear;
  if (joinDate > year.to) return 0;
  const months = (Number(year.to.slice(0, 4)) * 12 + Number(year.to.slice(5, 7))) - (Number(joinDate.slice(0, 4)) * 12 + Number(joinDate.slice(5, 7))) + 1;
  return Math.round((daysPerYear * months) / 12 * 2) / 2;
}
