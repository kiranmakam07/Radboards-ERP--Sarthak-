import { sql } from 'drizzle-orm';
import { GST_RETURN_LABELS, formatDate, monthName } from '@radcore/shared';
import { rows, type DB } from '../db/client';
import { conflict } from '../lib/errors';

/**
 * A month whose GST return is filed is closed for the documents that return reports (technical review,
 * 26 Oct 2026: "cancelling an old invoice can quietly change a return already filed"). GSTR-1 closes the
 * month's invoices and credit notes, GSTR-3B its purchase bills and debit notes. A mistake found after that
 * is corrected with a document dated now (a credit note, a debit note), which goes in the next return, as
 * the GST law expects. Months are marked filed on the GST screen (modules/gst.ts, table gst_filings).
 *
 * `what` finishes the sentence: "... so <what>." e.g. "invoice INV/26-27/00004 cannot be cancelled".
 */
export async function assertGstOpen(tx: DB, date: string, side: 'sales' | 'purchases', what: string): Promise<void> {
  const returnType = side === 'sales' ? 'gstr1' : 'gstr3b';
  const period = date.slice(0, 7);
  const [filed] = await rows<{ filed_on: string }>(tx, sql`
    select filed_on::text from gst_filings where return_type = ${returnType} and period = ${period}`);
  if (!filed) return;
  const fix = side === 'sales' ? 'Correct it with a credit note dated today.' : 'Correct it with a debit note, or date the bill in the current month.';
  throw conflict(
    `${GST_RETURN_LABELS[returnType]} for ${monthName(period)} was filed on ${formatDate(filed.filed_on)}, so ${what}. ${fix}`,
    { gst_filed: returnType, period },
  );
}
