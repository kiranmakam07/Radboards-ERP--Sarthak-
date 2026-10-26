-- Sales pipeline for vehicles (P2 of the brief): the stages test ride booked, test ride done, quoted, booked and delivered between meeting booked and converted; test rides on demo units; the delivery checklist; delivery photos and signed notes as a kind of file.
CREATE TYPE "public"."test_ride_outcome" AS ENUM('booked', 'done', 'no_show', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."lead_stage" ADD VALUE 'test_ride_booked' BEFORE 'converted';--> statement-breakpoint
ALTER TYPE "public"."lead_stage" ADD VALUE 'test_ride_done' BEFORE 'converted';--> statement-breakpoint
ALTER TYPE "public"."lead_stage" ADD VALUE 'quoted' BEFORE 'converted';--> statement-breakpoint
ALTER TYPE "public"."lead_stage" ADD VALUE 'booked' BEFORE 'converted';--> statement-breakpoint
ALTER TYPE "public"."lead_stage" ADD VALUE 'delivered' BEFORE 'converted';--> statement-breakpoint
CREATE TABLE "delivery_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sales_order_id" uuid NOT NULL,
	"pdi_done" boolean DEFAULT false NOT NULL,
	"rider_briefing" boolean DEFAULT false NOT NULL,
	"warranty_registered" boolean DEFAULT false NOT NULL,
	"photo_file_id" uuid,
	"signed_note_file_id" uuid,
	"checked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "delivery_checks_sales_order_id_unique" UNIQUE("sales_order_id")
);
--> statement-breakpoint
CREATE TABLE "test_rides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"slot_at" timestamp with time zone NOT NULL,
	"minutes" integer DEFAULT 30 NOT NULL,
	"staff_id" uuid,
	"outcome" "test_ride_outcome" DEFAULT 'booked' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "test_rides_minutes_chk" CHECK ("test_rides"."minutes" between 5 and 480)
);
--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_purpose_chk";--> statement-breakpoint
ALTER TABLE "delivery_checks" ADD CONSTRAINT "delivery_checks_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_checks" ADD CONSTRAINT "delivery_checks_photo_file_id_files_id_fk" FOREIGN KEY ("photo_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_checks" ADD CONSTRAINT "delivery_checks_signed_note_file_id_files_id_fk" FOREIGN KEY ("signed_note_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_checks" ADD CONSTRAINT "delivery_checks_checked_by_users_id_fk" FOREIGN KEY ("checked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_rides" ADD CONSTRAINT "test_rides_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_rides" ADD CONSTRAINT "test_rides_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_rides" ADD CONSTRAINT "test_rides_staff_id_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "test_rides_unit_idx" ON "test_rides" USING btree ("unit_id","slot_at");--> statement-breakpoint
CREATE INDEX "test_rides_lead_idx" ON "test_rides" USING btree ("lead_id");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_purpose_chk" CHECK ("files"."purpose" in ('resume', 'bill', 'item_image', 'share', 'other', 'service', 'delivery'));