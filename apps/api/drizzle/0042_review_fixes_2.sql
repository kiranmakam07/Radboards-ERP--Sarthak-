-- Code review (27 Oct 2026): a booking advance names its order, and a journal entry is reversed at most once.
DROP INDEX "journal_entries_reverses_idx";--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "sales_order_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_reverses_uq" ON "journal_entries" USING btree ("reverses_entry_id") WHERE "journal_entries"."reverses_entry_id" is not null;--> statement-breakpoint
-- Advances taken before this: linked by the note the booking wrote on them.
UPDATE "payments" p SET "sales_order_id" = o."id" FROM "sales_orders" o WHERE p."sales_order_id" IS NULL AND p."notes" = 'Advance for ' || o."order_no";
