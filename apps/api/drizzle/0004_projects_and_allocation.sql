CREATE TYPE "public"."project_status" AS ENUM('planned', 'active', 'on_hold', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"label" text,
	"employee_id" uuid,
	"asset_id" uuid,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"percent" integer DEFAULT 100 NOT NULL,
	"role" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "allocations_one_resource_chk" CHECK (("allocations"."employee_id" is not null) <> ("allocations"."asset_id" is not null)),
	CONSTRAINT "allocations_work_chk" CHECK ("allocations"."project_id" is not null or "allocations"."label" is not null),
	CONSTRAINT "allocations_dates_chk" CHECK ("allocations"."to_date" >= "allocations"."from_date"),
	CONSTRAINT "allocations_percent_chk" CHECK ("allocations"."percent" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_no" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"owner_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"deadline" date,
	"status" "project_status" DEFAULT 'planned' NOT NULL,
	"completed_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "projects_project_no_unique" UNIQUE("project_no"),
	CONSTRAINT "projects_deadline_chk" CHECK ("projects"."deadline" is null or "projects"."deadline" >= "projects"."start_date"),
	CONSTRAINT "projects_done_chk" CHECK (("projects"."status" = 'done') = ("projects"."completed_on" is not null))
);
--> statement-breakpoint
ALTER TABLE "task_templates" ADD COLUMN "due_time" time;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "start_date" date;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "due_time" time;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allocations_employee_idx" ON "allocations" USING btree ("employee_id","from_date");--> statement-breakpoint
CREATE INDEX "allocations_asset_idx" ON "allocations" USING btree ("asset_id","from_date");--> statement-breakpoint
CREATE INDEX "allocations_project_idx" ON "allocations" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_project_idx" ON "tasks" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_start_chk" CHECK ("tasks"."start_date" is null or "tasks"."start_date" <= "tasks"."due_date");