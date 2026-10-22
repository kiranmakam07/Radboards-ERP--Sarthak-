-- EV kinds (P1): vehicle, sub-assembly, accessory and consumable items; service bay, demo, franchise and in-transit places; franchisee parties. Enums only grow, so the new values go at the end.
ALTER TYPE "public"."item_type" ADD VALUE 'vehicle';--> statement-breakpoint
ALTER TYPE "public"."item_type" ADD VALUE 'sub_assembly';--> statement-breakpoint
ALTER TYPE "public"."item_type" ADD VALUE 'accessory';--> statement-breakpoint
ALTER TYPE "public"."item_type" ADD VALUE 'consumable';--> statement-breakpoint
ALTER TYPE "public"."location_type" ADD VALUE 'service_bay';--> statement-breakpoint
ALTER TYPE "public"."location_type" ADD VALUE 'demo';--> statement-breakpoint
ALTER TYPE "public"."location_type" ADD VALUE 'franchise';--> statement-breakpoint
ALTER TYPE "public"."location_type" ADD VALUE 'in_transit';--> statement-breakpoint
ALTER TYPE "public"."party_type" ADD VALUE 'franchisee';