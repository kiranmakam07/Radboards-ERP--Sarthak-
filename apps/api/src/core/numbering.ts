import { and, eq } from 'drizzle-orm';
import { fyOf, fyShort } from '@radcore/shared';
import type { DB } from '../db/client';
import { entities, numberSeries } from '../db/schema';
import { defaultEntityId } from './settings';

/**
 * Document numbers. Each kind of document has its own series; nextNumber hands out the next one
 * inside the caller's transaction, so a number is used only if the document is saved.
 * To number a new kind of document, add one line to SERIES: the series row in the database is
 * made the first time it is asked for.
 */

type SeriesDef = { prefix: (fyShortLabel: string) => string; pad: number; perFy: boolean; start?: number };

/**
 * Document number formats. GST documents (invoice / credit note / debit note) have separate
 * series, are consecutive per financial year and stay within 16 characters (PRD 7.9):
 * "INV/26-27/00001" is 15.
 */
export const SERIES = {
  invoice: { prefix: (fy) => `INV/${fy}/`, pad: 5, perFy: true },
  credit_note: { prefix: (fy) => `CN/${fy}/`, pad: 5, perFy: true },
  debit_note: { prefix: (fy) => `DN/${fy}/`, pad: 5, perFy: true },
  sales_order: { prefix: (fy) => `SO/${fy}/`, pad: 5, perFy: true },
  delivery: { prefix: (fy) => `DC/${fy}/`, pad: 5, perFy: true },
  receipt: { prefix: (fy) => `RCT/${fy}/`, pad: 5, perFy: true },
  payment_out: { prefix: (fy) => `PAY/${fy}/`, pad: 5, perFy: true },
  purchase_order: { prefix: (fy) => `PO/${fy}/`, pad: 5, perFy: true },
  goods_receipt: { prefix: (fy) => `GRN/${fy}/`, pad: 5, perFy: true },
  purchase_bill: { prefix: (fy) => `PB/${fy}/`, pad: 5, perFy: true },
  purchase_return: { prefix: (fy) => `PR/${fy}/`, pad: 5, perFy: true },
  expense: { prefix: (fy) => `EXP/${fy}/`, pad: 5, perFy: true },
  stock_transfer: { prefix: (fy) => `ST/${fy}/`, pad: 5, perFy: true },
  stock_adjustment: { prefix: (fy) => `SA/${fy}/`, pad: 5, perFy: true },
  job_work: { prefix: (fy) => `JW/${fy}/`, pad: 5, perFy: true },
  job_work_receipt: { prefix: (fy) => `JWR/${fy}/`, pad: 5, perFy: true },
  job_card: { prefix: (fy) => `JC/${fy}/`, pad: 5, perFy: true },
  import_shipment: { prefix: (fy) => `IMP/${fy}/`, pad: 5, perFy: true },
  lead: { prefix: () => 'L', pad: 0, perFy: false, start: 1001 },
  applicant: { prefix: () => 'A', pad: 0, perFy: false, start: 1001 },
  employee: { prefix: () => 'EMP', pad: 3, perFy: false },
  asset: { prefix: () => 'AST', pad: 3, perFy: false },
  project: { prefix: () => 'PRJ', pad: 3, perFy: false },
} as const satisfies Record<string, SeriesDef>;

export type SeriesKey = keyof typeof SERIES;

/**
 * Gap-free numbering (PRD section 9). The series row is locked with SELECT ... FOR UPDATE
 * inside the caller's transaction, so two bills saved at the same moment queue up, and a
 * rolled-back transaction hands its number back.
 */
export async function nextNumber(tx: DB, docType: SeriesKey, date: string, entityId?: string | null): Promise<{ number: string; fy: string }> {
  const def: SeriesDef = SERIES[docType];
  const fy = def.perFy ? fyOf(date) : 'ALL';
  // Each legal entity numbers its own documents. The first one keeps the plain prefixes; another one
  // puts its letter in front (BINV/26-27/00001), so the numbers never clash and stay within 16 characters.
  const entity = entityId ?? (await defaultEntityId(tx));
  const [owner] = await tx.select({ code: entities.code, isDefault: entities.isDefault }).from(entities).where(eq(entities.id, entity));
  const letter = owner && !owner.isDefault ? (owner.code ?? '') : '';
  await tx
    .insert(numberSeries)
    .values({ docType, fy, prefix: `${letter}${def.prefix(fyShort(date))}`, nextValue: def.start ?? 1, entityId: entity })
    .onConflictDoNothing();
  const [series] = await tx
    .select()
    .from(numberSeries)
    .where(and(eq(numberSeries.docType, docType), eq(numberSeries.fy, fy), eq(numberSeries.entityId, entity)))
    .for('update');
  if (!series) throw new Error(`number series missing for ${docType} ${fy}`);
  await tx
    .update(numberSeries)
    .set({ nextValue: series.nextValue + 1, updatedAt: new Date() })
    .where(eq(numberSeries.id, series.id));
  const n = String(series.nextValue).padStart(def.pad, '0');
  return { number: `${series.prefix}${n}`, fy };
}
