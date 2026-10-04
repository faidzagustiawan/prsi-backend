CREATE SCHEMA IF NOT EXISTS "finance";
--> statement-breakpoint
CREATE TYPE "finance"."si_role" AS ENUM('super_admin', 'finance_admin', 'finance_staff', 'viewer');--> statement-breakpoint
CREATE TYPE "finance"."user_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TABLE "finance"."audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"company_id" uuid,
	"action" varchar(100) NOT NULL,
	"entity" varchar(100) NOT NULL,
	"entity_id" varchar(100),
	"summary" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"ip_address" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "finance"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"nama" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"role" "finance"."si_role" NOT NULL,
	"status" "finance"."user_status" DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "finance"."audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "finance"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "finance"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "finance"."audit_logs" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_company_created_idx" ON "finance"."audit_logs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "rt_user_idx" ON "finance"."refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "users_company_idx" ON "finance"."users" USING btree ("company_id");