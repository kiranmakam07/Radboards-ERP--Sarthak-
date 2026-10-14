'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatINR } from '@radcore/shared';

/**
 * The few chart shapes the dashboards need, drawn as plain HTML/SVG (no chart library).
 * Rules they all follow: thin marks, one colour per series in a fixed order, values
 * readable without hovering (labels or the table underneath), and hover/focus for detail.
 * Colours are the --viz-* variables in globals.css.
 */

const SERIES = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)'];

export const count = (v: number) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(v);
/** "1 invoice", "3 invoices"; pass the plural when it is not just an added "s" ("entry", "entries"). */
export const plural = (n: number, word: string, many = `${word}s`) => `${count(n)} ${Number(n) === 1 ? word : many}`;
export const rupees = (v: number) => `₹${formatINR(v).replace(/\.00$/, '')}`;
/** Axis-sized rupees: ₹950, ₹12.5K, ₹3.4L, ₹1.2Cr. */
export function compactRupees(v: number): string {
  const a = Math.abs(v);
  const short = (n: number, unit: string) => `${v < 0 ? '-' : ''}₹${Number(n.toFixed(n >= 100 ? 0 : 1))}${unit}`;
  if (a >= 1e7) return short(a / 1e7, 'Cr');
  if (a >= 1e5) return short(a / 1e5, 'L');
  if (a >= 1e3) return short(a / 1e3, 'K');
  return `${v < 0 ? '-' : ''}₹${Math.round(a)}`;
}

/** Round the top of the scale up to a clean number and return about four even steps. Counts of things never get half-steps. */
function niceScale(max: number, whole = false): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 1, ticks: [0, 1] };
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const clean = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
  const step = whole ? Math.max(1, Math.ceil(clean)) : clean;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(Number(t.toFixed(6)));
  return { top, ticks };
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

type Tip = { x: number; y: number; title: string; rows: { name?: string; value: string; color?: string }[] } | null;

function Tooltip({ tip, width }: { tip: Tip; width: number }) {
  if (!tip) return null;
  const left = Math.min(Math.max(tip.x, 70), Math.max(width - 70, 70));
  return (
    <div className="viz-tip" style={{ left, top: tip.y }} role="status">
      <div className="viz-tip-title">{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div key={i} className="viz-tip-row">
          {r.color ? <span className="viz-key" style={{ background: r.color }} /> : null}
          <strong>{r.value}</strong>{r.name ? <span> {r.name}</span> : null}
        </div>
      ))}
    </div>
  );
}

function Legend({ names }: { names: string[] }) {
  if (names.length < 2) return null; // one series is named by the chart title
  return (
    <div className="viz-legend">
      {names.map((n, i) => <span key={n}><i style={{ background: SERIES[i] }} />{n}</span>)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal bars: comparing items (channels, sources, categories, top lists)
// ---------------------------------------------------------------------------
export type Bar = { label: string; value: number; note?: string; href?: string | null };

export function BarList({ data, format = count, empty = 'Nothing to show.' }: { data: Bar[]; format?: (v: number) => string; empty?: string }) {
  if (data.length === 0) return <p className="muted">{empty}</p>;
  const max = Math.max(...data.map((d) => d.value), 0);
  return (
    <div className="viz-bars">
      {data.map((d) => (
        <div className="viz-bar-row" key={d.label} title={`${d.label}: ${format(d.value)}${d.note ? ` (${d.note})` : ''}`}>
          <div className="viz-bar-label">{d.href ? <Link href={d.href}>{d.label}</Link> : d.label}</div>
          <div className="viz-bar-track">
            <div className="viz-bar" style={{ width: max > 0 && d.value > 0 ? `max(2px, ${(d.value / max) * 100}%)` : 0 }} />
          </div>
          <div className="viz-bar-value">{format(d.value)}{d.note ? <span className="muted"> · {d.note}</span> : null}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A value against a limit (dealer outstanding vs credit limit)
// ---------------------------------------------------------------------------
export type MeterRow = { label: string; value: number; limit: number | null; href?: string | null };

export function MeterList({ data, format = count, empty = 'Nothing to show.' }: { data: MeterRow[]; format?: (v: number) => string; empty?: string }) {
  if (data.length === 0) return <p className="muted">{empty}</p>;
  return (
    <div className="viz-bars">
      {data.map((d) => {
        const used = d.limit && d.limit > 0 ? (d.value / d.limit) * 100 : null;
        // Colour is backed by words: the percentage and "over limit" are always written out.
        const level = used === null ? '' : used >= 100 ? 'critical' : used >= 80 ? 'warning' : '';
        return (
          <div className="viz-bar-row" key={d.label} title={`${d.label}: ${format(d.value)}${d.limit ? ` of ${format(d.limit)}` : ''}`}>
            <div className="viz-bar-label">{d.href ? <Link href={d.href}>{d.label}</Link> : d.label}</div>
            <div className="viz-meter">{used !== null && <div className={`viz-meter-fill ${level}`} style={{ width: `${Math.min(Math.max(used, 0), 100)}%` }} />}</div>
            <div className="viz-bar-value">
              {format(d.value)}
              <span className="muted">{d.limit ? ` of ${format(d.limit)} · ${Math.round(used ?? 0)}%${(used ?? 0) >= 100 ? ', over limit' : ''}` : ' · no limit set'}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Columns over an ordered axis (age buckets, hours of the day). Up to three stacked series.
// ---------------------------------------------------------------------------
export type Column = { label: string; values: number[] };

export function ColumnChart({
  data, series, format = count, axisFormat, height = 220, empty = 'Nothing to show.',
}: {
  data: Column[]; series: string[]; format?: (v: number) => string; axisFormat?: (v: number) => string; height?: number; empty?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  const totals = data.map((d) => d.values.reduce((a, b) => a + b, 0));
  if (data.length === 0 || Math.max(...totals) <= 0) return <p className="muted">{empty}</p>;
  const axis = axisFormat ?? format;
  const { top, ticks } = niceScale(Math.max(...totals), format === count);
  const pad = { left: 52, right: 8, top: 10, bottom: 26 };
  const plotW = Math.max(width - pad.left - pad.right, 10);
  const plotH = height - pad.top - pad.bottom;
  const band = plotW / data.length;
  const barW = Math.min(24, Math.max(4, band - 6));
  const y = (v: number) => pad.top + plotH - (v / top) * plotH;
  // Show every nth label so they never run into each other.
  const every = Math.ceil((data.length * 34) / plotW) || 1;

  return (
    <div className="viz" ref={ref}>
      <Legend names={series} />
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`${series.join(' and ')} by ${data[0]!.label} to ${data.at(-1)!.label}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-axis' : 'viz-grid'} />
              <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className="viz-tick">{axis(t)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = pad.left + band * i + band / 2;
            let base = 0;
            const last = d.values.reduce((acc, v, si) => (v > 0 ? si : acc), -1);
            return (
              <g key={d.label}>
                {d.values.map((v, si) => {
                  if (v <= 0) return null;
                  const y1 = y(base + v);
                  // 2px of surface between stacked segments; only the top segment has the rounded data-end.
                  const h = Math.max(y(base) - y1 - (base > 0 ? 2 : 0), 1);
                  base += v;
                  const r = si === last ? Math.min(4, h, barW / 2) : 0;
                  const x0 = cx - barW / 2;
                  return (
                    <path key={si} fill={SERIES[si]}
                      d={`M${x0} ${y1 + h}V${y1 + r}Q${x0} ${y1} ${x0 + r} ${y1}H${x0 + barW - r}Q${x0 + barW} ${y1} ${x0 + barW} ${y1 + r}V${y1 + h}Z`} />
                  );
                })}
                {i % every === 0 && <text x={cx} y={height - 8} textAnchor="middle" className="viz-tick">{d.label}</text>}
                <rect x={pad.left + band * i} y={pad.top} width={band} height={plotH} className="viz-hit" tabIndex={0}
                  aria-label={`${d.label}: ${d.values.map((v, si) => `${format(v)} ${series[si] ?? ''}`).join(', ')}`}
                  onPointerMove={() => setTip({ x: cx, y: y(totals[i]!) - 8, title: d.label, rows: d.values.map((v, si) => ({ value: format(v), name: series.length > 1 ? series[si] : undefined, color: series.length > 1 ? SERIES[si] : undefined })) })}
                  onFocus={() => setTip({ x: cx, y: y(totals[i]!) - 8, title: d.label, rows: d.values.map((v, si) => ({ value: format(v), name: series.length > 1 ? series[si] : undefined, color: series.length > 1 ? SERIES[si] : undefined })) })}
                  onPointerLeave={() => setTip(null)} onBlur={() => setTip(null)} />
              </g>
            );
          })}
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// One series over time (sales per day, leads per day)
// ---------------------------------------------------------------------------
export type Point = { date: string; value: number };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

/** Every day from `from` to `to`, with 0 where the data has no row, so quiet days show as dips, not gaps. */
export function fillDays(rows: { day: string; value: number }[], from: string, to: string): Point[] {
  const byDay = new Map(rows.map((r) => [r.day.slice(0, 10), r.value]));
  const out: Point[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end && out.length < 400; t += 86400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    out.push({ date, value: byDay.get(date) ?? 0 });
  }
  return out;
}

export function LineChart({
  points, name, singular, format = count, axisFormat, height = 220, empty = 'Nothing to show.',
}: {
  points: Point[]; name: string; singular?: string; format?: (v: number) => string; axisFormat?: (v: number) => string; height?: number; empty?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [at, setAt] = useState<number | null>(null);
  if (points.length === 0 || Math.max(...points.map((p) => p.value)) <= 0) return <p className="muted">{empty}</p>;
  const axis = axisFormat ?? format;
  const { top, ticks } = niceScale(Math.max(...points.map((p) => p.value)), format === count);
  const pad = { left: 52, right: 16, top: 12, bottom: 26 };
  const plotW = Math.max(width - pad.left - pad.right, 10);
  const plotH = height - pad.top - pad.bottom;
  const x = (i: number) => pad.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => pad.top + plotH - (v / top) * plotH;
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join('');
  const area = `${line}L${x(points.length - 1).toFixed(1)} ${y(0)}L${x(0).toFixed(1)} ${y(0)}Z`;
  const every = Math.max(1, Math.ceil((points.length * 52) / plotW));
  const nearest = (clientX: number, target: Element) => {
    const rect = target.getBoundingClientRect();
    const ratio = (clientX - rect.left - pad.left) / plotW;
    return Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1))));
  };
  const shown = at ?? points.length - 1;
  const p = points[shown]!;

  return (
    <div className="viz" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" tabIndex={0} aria-label={`${name} per day, ${shortDate(points[0]!.date)} to ${shortDate(points.at(-1)!.date)}`}
          onPointerMove={(e) => setAt(nearest(e.clientX, e.currentTarget))} onPointerLeave={() => setAt(null)} onBlur={() => setAt(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setAt(Math.max(0, shown - 1));
            if (e.key === 'ArrowRight') setAt(Math.min(points.length - 1, shown + 1));
          }}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-axis' : 'viz-grid'} />
              <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className="viz-tick">{axis(t)}</text>
            </g>
          ))}
          {points.map((pt, i) => (i % every === 0 ? <text key={pt.date} x={x(i)} y={height - 8} textAnchor="middle" className="viz-tick">{shortDate(pt.date)}</text> : null))}
          <path d={area} fill="var(--viz-1)" fillOpacity="0.1" />
          <path d={line} fill="none" stroke="var(--viz-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {at !== null && <line x1={x(shown)} x2={x(shown)} y1={pad.top} y2={y(0)} className="viz-axis" />}
          <circle cx={x(shown)} cy={y(p.value)} r="5" fill="var(--viz-1)" stroke="var(--panel)" strokeWidth="2" />
        </svg>
      )}
      <Tooltip width={width} tip={width > 0 ? { x: x(shown), y: y(p.value) - 10, title: shortDate(p.date), rows: [{ value: format(p.value), name: p.value === 1 && singular ? singular : name }] } : null} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart + the same numbers as a table (so nothing depends on colour or hovering)
// ---------------------------------------------------------------------------
export function ChartCard({ title, actions, children, table }: { title: string; actions?: ReactNode; children: ReactNode; table?: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head"><h2>{title}</h2><div className="actions no-print">{actions}</div></div>
      {children}
      {table ? <details className="viz-table"><summary>Show as table</summary>{table}</details> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Where a document is in its life: Draft > Confirmed > Delivered > Invoiced
// ---------------------------------------------------------------------------
export function Steps({ steps, current, stopped }: { steps: string[]; current: number; stopped?: string | null }) {
  return (
    <ol className="steps" aria-label="Progress">
      {steps.map((s, i) => (
        <li key={s} className={stopped ? 'todo' : i < current ? 'done' : i === current ? 'now' : 'todo'} aria-current={!stopped && i === current ? 'step' : undefined}>
          <span className="dot">{!stopped && i < current ? '✓' : i + 1}</span>{s}
        </li>
      ))}
      {stopped ? <li className="stopped"><span className="dot">×</span>{stopped}</li> : null}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// The home-screen picture: what is waiting at each step, with a link to the list behind it
// ---------------------------------------------------------------------------
export type FlowStep = { label: string; value: number | string; note?: string; href: string; alert?: boolean };

export function Flow({ title, steps, arrows = true }: { title: string; steps: FlowStep[]; arrows?: boolean }) {
  if (steps.length === 0) return null;
  return (
    <section className="flow">
      <h2>{title}</h2>
      <div className={arrows ? 'flow-row' : 'flow-row loose'}>
        {steps.map((s, i) => (
          <div className="flow-cell" key={s.label}>
            {arrows && i > 0 && <span className="flow-arrow" aria-hidden="true">→</span>}
            <Link href={s.href} className={s.alert ? 'flow-step alert' : 'flow-step'}>
              <span className="flow-value">{s.value}</span>
              <span className="flow-label">{s.label}</span>
              {s.note ? <span className="flow-note">{s.note}</span> : null}
            </Link>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// A plan against the calendar: one row per piece of work, a bar from its start to its
// deadline (or a marker on the deadline when no start was given), and a line for today.
// ---------------------------------------------------------------------------
export type TimelineRow = { label: string; from: string | null; to: string; state: 'open' | 'done' | 'late' | 'skipped'; note?: string; href?: string | null };

const dayNumber = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86400000;
const STATE_WORDS: Record<TimelineRow['state'], string> = { open: 'To do', done: 'Done', late: 'Late', skipped: 'Not done' };

export function Timeline({ rows, from, to, today, empty = 'Nothing planned yet.' }: { rows: TimelineRow[]; from: string; to: string; today: string; empty?: string }) {
  if (rows.length === 0) return <p className="muted">{empty}</p>;
  const start = dayNumber(from);
  const span = Math.max(dayNumber(to) - start + 1, 1);
  // Positions as a share of the whole period, clamped so nothing is drawn outside the track.
  const at = (d: string) => Math.min(100, Math.max(0, ((dayNumber(d) - start) / span) * 100));
  const todayAt = dayNumber(today) >= start && dayNumber(today) <= start + span ? at(today) + 50 / span : null;
  return (
    <div className="timeline" role="table" aria-label="Plan against the calendar">
      <div className="timeline-row timeline-head" role="row">
        <span role="columnheader">Work</span>
        <span className="timeline-track" role="columnheader">
          <span>{shortDate(from)}</span>
          {todayAt !== null ? <span className="timeline-today-label" style={{ left: `${todayAt}%` }}>Today</span> : null}
          <span>{shortDate(to)}</span>
        </span>
      </div>
      {rows.map((r, i) => {
        const left = r.from ? at(r.from) : at(r.to);
        const right = Math.min(100, at(r.to) + 100 / span);
        const name = r.href ? <Link href={r.href}>{r.label}</Link> : r.label;
        return (
          <div className="timeline-row" role="row" key={i}>
            <span role="cell" className="timeline-label">{name}<span className="muted small"> · {STATE_WORDS[r.state]}{r.note ? ` · ${r.note}` : ''}</span></span>
            <span className="timeline-track" role="cell">
              {todayAt !== null ? <span className="timeline-today" style={{ left: `${todayAt}%` }} /> : null}
              {r.from
                ? <span className={`timeline-bar ${r.state}`} style={{ left: `${left}%`, width: `${Math.max(right - left, 1)}%` }} title={`${shortDate(r.from)} to ${shortDate(r.to)}`} />
                : <span className={`timeline-mark ${r.state}`} style={{ left: `${Math.min(99, left + 50 / span)}%` }} title={`Deadline ${shortDate(r.to)}`} />}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shares of a whole: a ring with the total in the middle and a key beside it
// ---------------------------------------------------------------------------
export type Slice = { label: string; value: number; href?: string | null };
const SLICE_COLOURS = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)'];

/**
 * At most five slices, in a fixed colour order: the four largest and, when there are more, the rest
 * added up as "Others" in grey. Only for parts of a whole: nothing below zero is drawn.
 */
export function Donut({ data, format = count, caption = 'Total', empty = 'Nothing to show.' }: {
  data: Slice[]; format?: (v: number) => string; caption?: string; empty?: string;
}) {
  const positive = data.filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  const total = positive.reduce((s, d) => s + d.value, 0);
  if (total <= 0) return <p className="muted">{empty}</p>;
  const slices = positive.length > 5
    ? [...positive.slice(0, 4), { label: `Others (${positive.length - 4})`, value: positive.slice(4).reduce((s, d) => s + d.value, 0) }]
    : positive;
  const r = 38;
  const round = 2 * Math.PI * r;
  const gap = slices.length > 1 ? 1.2 : 0;
  let start = 0;
  return (
    <div className="viz donut">
      <svg viewBox="0 0 100 100" role="img" aria-label={`${caption}: ${format(total)}. ${slices.map((s) => `${s.label} ${format(s.value)}`).join(', ')}`}>
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--viz-grid)" strokeWidth="12" />
        {slices.map((s, i) => {
          const len = (s.value / total) * round;
          const dash = Math.max(len - gap, 0.5);
          const el = (
            <circle key={s.label} cx="50" cy="50" r={r} fill="none" stroke={SLICE_COLOURS[i]} strokeWidth="12"
              strokeDasharray={`${dash} ${round - dash}`} strokeDashoffset={-start} transform="rotate(-90 50 50)">
              <title>{`${s.label}: ${format(s.value)} (${Math.round((s.value / total) * 100)}%)`}</title>
            </circle>
          );
          start += len;
          return el;
        })}
        <text x="50" y="50" textAnchor="middle" className="donut-total">{format(total)}</text>
        <text x="50" y="60" textAnchor="middle" className="donut-caption">{caption}</text>
      </svg>
      <ul className="donut-key">
        {slices.map((s, i) => (
          <li key={s.label}>
            <i style={{ background: SLICE_COLOURS[i] }} />
            <span>{'href' in s && s.href ? <Link href={s.href}>{s.label}</Link> : s.label}</span>
            <span>{format(s.value)} <span className="muted">· {Math.round((s.value / total) * 100)}%</span></span>
          </li>
        ))}
      </ul>
    </div>
  );
}
