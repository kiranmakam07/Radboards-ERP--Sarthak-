-- Stock reservations (P1): stock held for one sales order. v_stock_on_hand keeps qty (on hand) and gains reserved and available.
CREATE TYPE "public"."reservation_status" AS ENUM('open', 'fulfilled', 'released', 'expired');--> statement-breakpoint
CREATE TABLE "stock_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"unit_id" uuid,
	"qty" numeric(12, 3) NOT NULL,
	"sales_order_id" uuid NOT NULL,
	"sales_order_line_id" uuid,
	"expires_on" date,
	"status" "reservation_status" DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "stock_reservations_qty_pos" CHECK ("stock_reservations"."qty" > 0),
	CONSTRAINT "stock_reservations_unit_qty_chk" CHECK ("stock_reservations"."unit_id" is null or "stock_reservations"."qty" = 1)
);
--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_sales_order_line_id_sales_order_lines_id_fk" FOREIGN KEY ("sales_order_line_id") REFERENCES "public"."sales_order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_reservations_item_loc_idx" ON "stock_reservations" USING btree ("item_id","location_id");--> statement-breakpoint
CREATE INDEX "stock_reservations_order_idx" ON "stock_reservations" USING btree ("sales_order_id");--> statement-breakpoint
-- Available = on hand less the open reservations (not yet past their date). qty stays what it always was.
CREATE OR REPLACE VIEW v_stock_on_hand AS
  SELECT m.item_id, m.location_id, m.qty,
         coalesce(r.qty, 0) AS reserved,
         m.qty - coalesce(r.qty, 0) AS available
    FROM (SELECT item_id, location_id, sum(qty) AS qty FROM stock_movements GROUP BY item_id, location_id) m
    LEFT JOIN (SELECT item_id, location_id, sum(qty) AS qty FROM stock_reservations
                WHERE status = 'open' AND (expires_on IS NULL OR expires_on >= (now() AT TIME ZONE 'Asia/Kolkata')::date)
                GROUP BY item_id, location_id) r
      ON r.item_id = m.item_id AND r.location_id = m.location_id;
