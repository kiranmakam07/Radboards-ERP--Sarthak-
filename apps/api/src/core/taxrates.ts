import { sql } from 'drizzle-orm';
import { rows, type DB } from '../db/client';

/**
 * The GST rate an item carries on a given day. When the rate table (tax_rates) has a row for the
 * item's HSN, or for a shorter code it starts with, the latest one in force on that day wins (the
 * longest code first: 8703 80 beats 87). Otherwise the item's own rate stands. Every document line
 * takes its rate this way on its document's date, so a rate change is set once, ahead of time, and
 * applies from its day on.
 */
export async function taxRateOn(
  tx: DB,
  item: { hsnSac: string | null; gstRate: string; cessRate: string },
  date: string,
): Promise<{ gstRate: string; cessRate: string }> {
  if (!item.hsnSac) return { gstRate: item.gstRate, cessRate: item.cessRate };
  const [r] = await rows<{ gst_rate: string; cess_rate: string }>(tx, sql`
    select gst_rate::text, cess_rate::text from tax_rates
     where ${item.hsnSac} like hsn || '%' and effective_from <= ${date}::date
     order by length(hsn) desc, effective_from desc limit 1`);
  return r ? { gstRate: r.gst_rate, cessRate: r.cess_rate } : { gstRate: item.gstRate, cessRate: item.cessRate };
}
