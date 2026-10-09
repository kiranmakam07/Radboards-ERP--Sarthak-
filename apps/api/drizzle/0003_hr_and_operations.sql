CREATE TYPE "public"."applicant_activity_type" AS ENUM('note', 'call', 'stage_change', 'interview');--> statement-breakpoint
CREATE TYPE "public"."applicant_source" AS ENUM('job_portal', 'referral', 'walk_in', 'website', 'social_media', 'consultant', 'campus', 'other');--> statement-breakpoint
CREATE TYPE "public"."applicant_stage" AS ENUM('applied', 'shortlisted', 'interview', 'offered', 'hired', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('in_use', 'under_repair', 'retired');--> statement-breakpoint
CREATE TYPE "public"."attendance_status" AS ENUM('present', 'half_day', 'absent', 'leave', 'weekly_off', 'holiday');--> statement-breakpoint
CREATE TYPE "public"."employee_status" AS ENUM('active', 'left');--> statement-breakpoint
CREATE TYPE "public"."employment_type" AS ENUM('full_time', 'part_time', 'contract', 'intern');--> statement-breakpoint
CREATE TYPE "public"."interval_unit" AS ENUM('days', 'months');--> statement-breakpoint
CREATE TYPE "public"."interview_mode" AS ENUM('in_person', 'phone', 'video');--> statement-breakpoint
CREATE TYPE "public"."interview_result" AS ENUM('pass', 'hold', 'fail');--> statement-breakpoint
CREATE TYPE "public"."interview_status" AS ENUM('scheduled', 'completed', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."opening_status" AS ENUM('open', 'on_hold', 'closed');--> statement-breakpoint
CREATE TYPE "public"."reject_reason" AS ENUM('not_qualified', 'failed_interview', 'salary_mismatch', 'declined_offer', 'no_show', 'position_filled', 'other');--> statement-breakpoint
CREATE TYPE "public"."task_frequency" AS ENUM('daily', 'weekly', 'monthly', 'need_based');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('open', 'done', 'skipped');--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'hr';--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'operations';--> statement-breakpoint
CREATE TABLE "applicant_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"applicant_id" uuid NOT NULL,
	"type" "applicant_activity_type" NOT NULL,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "applicants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"applicant_no" text NOT NULL,
	"opening_id" uuid,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"source" "applicant_source" NOT NULL,
	"source_detail" text,
	"resume_url" text,
	"experience_years" numeric(4, 1),
	"current_company" text,
	"expected_salary" numeric(12, 2),
	"stage" "applicant_stage" DEFAULT 'applied' NOT NULL,
	"reject_reason" "reject_reason",
	"owner_id" uuid,
	"applied_on" date NOT NULL,
	"qualified_at" timestamp with time zone,
	"employee_id" uuid,
	"closed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "applicants_applicant_no_unique" UNIQUE("applicant_no"),
	CONSTRAINT "applicants_reject_reason_chk" CHECK (("applicants"."stage" = 'rejected') = ("applicants"."reject_reason" is not null)),
	CONSTRAINT "applicants_hired_chk" CHECK (("applicants"."stage" = 'hired') = ("applicants"."employee_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_no" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"location" text,
	"serial_no" text,
	"purchase_date" date,
	"purchase_cost" numeric(12, 2),
	"status" "asset_status" DEFAULT 'in_use' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "assets_asset_no_unique" UNIQUE("asset_no")
);
--> statement-breakpoint
CREATE TABLE "attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"date" date NOT NULL,
	"status" "attendance_status" NOT NULL,
	"check_in" time,
	"check_out" time,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "attendance_employee_day_uq" UNIQUE("employee_id","date")
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_no" text NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"department" text NOT NULL,
	"designation" text NOT NULL,
	"employment_type" "employment_type" DEFAULT 'full_time' NOT NULL,
	"join_date" date NOT NULL,
	"monthly_salary" numeric(12, 2),
	"user_id" uuid,
	"status" "employee_status" DEFAULT 'active' NOT NULL,
	"left_on" date,
	"left_reason" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "employees_employee_no_unique" UNIQUE("employee_no"),
	CONSTRAINT "employees_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "employees_left_chk" CHECK (("employees"."status" = 'left') = ("employees"."left_on" is not null))
);
--> statement-breakpoint
CREATE TABLE "interviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"applicant_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"title" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"mode" "interview_mode" DEFAULT 'in_person' NOT NULL,
	"interviewer_id" uuid,
	"status" "interview_status" DEFAULT 'scheduled' NOT NULL,
	"result" "interview_result",
	"rating" integer,
	"feedback" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "interviews_round_uq" UNIQUE("applicant_id","round"),
	CONSTRAINT "interviews_result_chk" CHECK (("interviews"."status" = 'completed') = ("interviews"."result" is not null)),
	CONSTRAINT "interviews_rating_chk" CHECK ("interviews"."rating" is null or "interviews"."rating" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "job_openings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"department" text NOT NULL,
	"positions" integer DEFAULT 1 NOT NULL,
	"status" "opening_status" DEFAULT 'open' NOT NULL,
	"description" text,
	"opened_on" date NOT NULL,
	"closed_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "job_openings_positions_chk" CHECK ("job_openings"."positions" > 0)
);
--> statement-breakpoint
CREATE TABLE "maintenance_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"schedule_id" uuid,
	"done_on" date NOT NULL,
	"done_by" text,
	"cost" numeric(12, 2),
	"notes" text,
	"next_due_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "maintenance_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"title" text NOT NULL,
	"interval_count" integer NOT NULL,
	"interval_unit" interval_unit NOT NULL,
	"next_due_on" date NOT NULL,
	"last_done_on" date,
	"assignee_id" uuid,
	"remind_days_before" integer DEFAULT 7 NOT NULL,
	"instructions" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "maintenance_schedules_interval_chk" CHECK ("maintenance_schedules"."interval_count" > 0 and "maintenance_schedules"."remind_days_before" >= 0)
);
--> statement-breakpoint
CREATE TABLE "task_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"frequency" "task_frequency" NOT NULL,
	"weekdays" smallint[] DEFAULT '{}'::smallint[] NOT NULL,
	"month_day" smallint,
	"assignee_id" uuid NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"start_date" date NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "task_templates_weekdays_chk" CHECK ("task_templates"."weekdays" <@ array[0,1,2,3,4,5,6]::smallint[] and ("task_templates"."frequency" not in ('daily','weekly') or cardinality("task_templates"."weekdays") > 0)),
	CONSTRAINT "task_templates_month_day_chk" CHECK ("task_templates"."frequency" <> 'monthly' or "task_templates"."month_day" between 1 and 31)
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid,
	"scheduled_for" date,
	"title" text NOT NULL,
	"description" text,
	"assignee_id" uuid NOT NULL,
	"due_date" date NOT NULL,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "tasks_template_day_uq" UNIQUE("template_id","scheduled_for"),
	CONSTRAINT "tasks_closed_chk" CHECK (("tasks"."status" = 'open') = ("tasks"."completed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "applicant_activities" ADD CONSTRAINT "applicant_activities_applicant_id_applicants_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."applicants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applicant_activities" ADD CONSTRAINT "applicant_activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applicants" ADD CONSTRAINT "applicants_opening_id_job_openings_id_fk" FOREIGN KEY ("opening_id") REFERENCES "public"."job_openings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applicants" ADD CONSTRAINT "applicants_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applicants" ADD CONSTRAINT "applicants_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_applicant_id_applicants_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."applicants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_interviewer_id_users_id_fk" FOREIGN KEY ("interviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_logs" ADD CONSTRAINT "maintenance_logs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_logs" ADD CONSTRAINT "maintenance_logs_schedule_id_maintenance_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."maintenance_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_templates" ADD CONSTRAINT "task_templates_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_template_id_task_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."task_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applicant_activities_applicant_idx" ON "applicant_activities" USING btree ("applicant_id");--> statement-breakpoint
CREATE INDEX "applicants_stage_idx" ON "applicants" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "applicants_opening_idx" ON "applicants" USING btree ("opening_id");--> statement-breakpoint
CREATE INDEX "applicants_phone_idx" ON "applicants" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "applicants_open_phone_uq" ON "applicants" USING btree ("phone") WHERE "applicants"."stage" in ('applied','shortlisted','interview','offered');--> statement-breakpoint
CREATE INDEX "attendance_date_idx" ON "attendance" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_active_phone_uq" ON "employees" USING btree ("phone") WHERE "employees"."status" = 'active';--> statement-breakpoint
CREATE INDEX "interviews_when_idx" ON "interviews" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "interviews_interviewer_idx" ON "interviews" USING btree ("interviewer_id");--> statement-breakpoint
CREATE INDEX "maintenance_logs_asset_idx" ON "maintenance_logs" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "maintenance_schedules_due_idx" ON "maintenance_schedules" USING btree ("next_due_on");--> statement-breakpoint
CREATE INDEX "maintenance_schedules_asset_idx" ON "maintenance_schedules" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee_id","status","due_date");--> statement-breakpoint
CREATE INDEX "tasks_due_idx" ON "tasks" USING btree ("due_date");