-- Technical review (26 Oct 2026): two people to reopen a closed year; salary history, so a past month keeps its salary;
-- leave beyond the allowance unpaid; payslip links that expire.
CREATE TABLE "salary_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"monthly_salary" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "salary_revisions_uq" UNIQUE("employee_id","effective_from"),
	CONSTRAINT "salary_revisions_amount_chk" CHECK ("salary_revisions"."monthly_salary" >= 0)
);
--> statement-breakpoint
ALTER TABLE "fiscal_closes" ADD COLUMN "reopen_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "fiscal_closes" ADD COLUMN "reopen_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fiscal_closes" ADD COLUMN "reopen_reason" text;--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "unpaid_leave" numeric(4, 1) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "salary_revisions" ADD CONSTRAINT "salary_revisions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_closes" ADD CONSTRAINT "fiscal_closes_reopen_requested_by_users_id_fk" FOREIGN KEY ("reopen_requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Everyone's salary as it stands becomes their first salary, from their joining date.
INSERT INTO "salary_revisions" ("employee_id", "effective_from", "monthly_salary")
SELECT "id", "join_date", "monthly_salary" FROM "employees" WHERE "monthly_salary" IS NOT NULL AND "monthly_salary" > 0;--> statement-breakpoint
-- Links already sent keep working for 30 days from today.
UPDATE "payslips" SET "token_expires_at" = now() + interval '30 days' WHERE "token" IS NOT NULL;
