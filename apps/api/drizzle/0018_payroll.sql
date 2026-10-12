CREATE TYPE "public"."payroll_run_status" AS ENUM('draft', 'approved', 'paid');--> statement-breakpoint
CREATE TABLE "advance_recoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"advance_id" uuid NOT NULL,
	"payslip_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"month" char(7) NOT NULL,
	"status" "payroll_run_status" DEFAULT 'draft' NOT NULL,
	"booked_on" date,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"paid_on" date,
	"paid_from_account_id" uuid,
	"payment_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "payroll_runs_month_unique" UNIQUE("month")
);
--> statement-breakpoint
CREATE TABLE "payslips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"employee_name" text NOT NULL,
	"employee_no" text NOT NULL,
	"department" text NOT NULL,
	"designation" text NOT NULL,
	"bank_account_no" text,
	"bank_ifsc" text,
	"monthly_salary" numeric(12, 2) NOT NULL,
	"days_in_month" integer NOT NULL,
	"paid_days" numeric(4, 1) NOT NULL,
	"present" integer DEFAULT 0 NOT NULL,
	"half_days" integer DEFAULT 0 NOT NULL,
	"leave_days" integer DEFAULT 0 NOT NULL,
	"weekly_off" integer DEFAULT 0 NOT NULL,
	"holidays" integer DEFAULT 0 NOT NULL,
	"absent" integer DEFAULT 0 NOT NULL,
	"not_marked" integer DEFAULT 0 NOT NULL,
	"gross_earned" numeric(12, 2) NOT NULL,
	"basic_earned" numeric(12, 2) NOT NULL,
	"allowance_earned" numeric(12, 2) NOT NULL,
	"pf_employee" numeric(12, 2) DEFAULT '0' NOT NULL,
	"pf_employer" numeric(12, 2) DEFAULT '0' NOT NULL,
	"esic_employee" numeric(12, 2) DEFAULT '0' NOT NULL,
	"esic_employer" numeric(12, 2) DEFAULT '0' NOT NULL,
	"pt" numeric(12, 2) DEFAULT '0' NOT NULL,
	"tds" numeric(12, 2) DEFAULT '0' NOT NULL,
	"advance_recovery" numeric(12, 2) DEFAULT '0' NOT NULL,
	"other_earning" numeric(12, 2) DEFAULT '0' NOT NULL,
	"other_deduction" numeric(12, 2) DEFAULT '0' NOT NULL,
	"net_pay" numeric(12, 2) NOT NULL,
	"note" text,
	"token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "payslips_token_unique" UNIQUE("token"),
	CONSTRAINT "payslips_run_employee_uq" UNIQUE("run_id","employee_id")
);
--> statement-breakpoint
CREATE TABLE "salary_advances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"given_on" date NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"monthly_recovery" numeric(12, 2) NOT NULL,
	"paid_from_account_id" uuid NOT NULL,
	"note" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "salary_advances_amount_chk" CHECK ("salary_advances"."amount" > 0 and "salary_advances"."monthly_recovery" > 0)
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "pf_applicable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "esic_applicable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "pt_monthly" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "tds_monthly" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "bank_account_no" text;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "bank_ifsc" text;--> statement-breakpoint
ALTER TABLE "advance_recoveries" ADD CONSTRAINT "advance_recoveries_advance_id_salary_advances_id_fk" FOREIGN KEY ("advance_id") REFERENCES "public"."salary_advances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advance_recoveries" ADD CONSTRAINT "advance_recoveries_payslip_id_payslips_id_fk" FOREIGN KEY ("payslip_id") REFERENCES "public"."payslips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_paid_from_account_id_accounts_id_fk" FOREIGN KEY ("paid_from_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_advances" ADD CONSTRAINT "salary_advances_paid_from_account_id_accounts_id_fk" FOREIGN KEY ("paid_from_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "advance_recoveries_advance_idx" ON "advance_recoveries" USING btree ("advance_id");--> statement-breakpoint
CREATE INDEX "salary_advances_employee_idx" ON "salary_advances" USING btree ("employee_id");