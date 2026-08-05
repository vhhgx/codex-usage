CREATE TYPE "public"."group_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('member', 'manager');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('super_admin', 'admin', 'operator', 'auditor', 'user');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled', 'locked');--> statement-breakpoint
CREATE TABLE "group_channel_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority_override" integer,
	"weight_override" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" DEFAULT 'member' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_model_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"public_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "group_status" DEFAULT 'active' NOT NULL,
	"allowed_endpoints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rpm_limit" integer,
	"concurrency_limit" integer,
	"daily_request_limit" bigint,
	"daily_token_limit" bigint,
	"daily_cost_limit" numeric(20, 8),
	"weekly_request_limit" bigint,
	"weekly_token_limit" bigint,
	"weekly_cost_limit" numeric(20, 8),
	"monthly_request_limit" bigint,
	"monthly_token_limit" bigint,
	"monthly_cost_limit" numeric(20, 8),
	"price_multiplier" numeric(12, 6) DEFAULT '1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_users" RENAME TO "users";--> statement-breakpoint
ALTER TABLE "usage_rollups" DROP CONSTRAINT "usage_rollups_dimensions_unique";--> statement-breakpoint
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_admin_id_admin_users_id_fk";
--> statement-breakpoint
ALTER TABLE "upstream_control_operations" DROP CONSTRAINT "upstream_control_operations_admin_id_admin_users_id_fk";
--> statement-breakpoint
DROP INDEX "admin_users_username_idx";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" "user_role" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" "user_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hub_key_credentials" ADD COLUMN "encrypted_key" text;--> statement-breakpoint
ALTER TABLE "hub_key_credentials" ADD COLUMN "encryption_key_version" text;--> statement-breakpoint
ALTER TABLE "hub_key_credentials" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "hub_keys" ADD COLUMN "encrypted_key" text;--> statement-breakpoint
ALTER TABLE "hub_keys" ADD COLUMN "encryption_key_version" text;--> statement-breakpoint
ALTER TABLE "hub_keys" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_keys" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "hub_keys" ADD COLUMN "secret_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hub_keys" ADD COLUMN "secret_updated_by" uuid;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "group_id" uuid;--> statement-breakpoint
UPDATE "users" SET "role" = 'super_admin', "password_changed_at" = COALESCE("password_changed_at", "created_at");--> statement-breakpoint
INSERT INTO "groups" ("id", "name", "description") VALUES ('00000000-0000-4000-8000-000000000001', '默认分组', '由系统迁移创建，用于承接现有 Hub Key');--> statement-breakpoint
INSERT INTO "group_memberships" ("group_id", "user_id", "role", "created_by")
SELECT '00000000-0000-4000-8000-000000000001', "id", 'manager', "id" FROM "users";--> statement-breakpoint
UPDATE "hub_keys" SET
  "owner_user_id" = (SELECT "id" FROM "users" ORDER BY "created_at" LIMIT 1),
  "group_id" = '00000000-0000-4000-8000-000000000001'
WHERE "owner_user_id" IS NULL;--> statement-breakpoint
UPDATE "request_logs" AS "log" SET
  "user_id" = "key"."owner_user_id",
  "group_id" = "key"."group_id"
FROM "hub_keys" AS "key"
WHERE "log"."key_id" = "key"."id" AND ("log"."user_id" IS NULL OR "log"."group_id" IS NULL);--> statement-breakpoint
UPDATE "usage_rollups" AS "rollup" SET
  "user_id" = "key"."owner_user_id",
  "group_id" = "key"."group_id"
FROM "hub_keys" AS "key"
WHERE "rollup"."key_id" = "key"."id" AND ("rollup"."user_id" IS NULL OR "rollup"."group_id" IS NULL);--> statement-breakpoint
ALTER TABLE "group_channel_rules" ADD CONSTRAINT "group_channel_rules_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_channel_rules" ADD CONSTRAINT "group_channel_rules_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_model_rules" ADD CONSTRAINT "group_model_rules_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "group_channel_rules_group_channel_idx" ON "group_channel_rules" USING btree ("group_id","channel_id");--> statement-breakpoint
CREATE INDEX "group_channel_rules_channel_idx" ON "group_channel_rules" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_memberships_group_user_idx" ON "group_memberships" USING btree ("group_id","user_id");--> statement-breakpoint
CREATE INDEX "group_memberships_user_idx" ON "group_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_model_rules_group_model_idx" ON "group_model_rules" USING btree ("group_id","public_model");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_name_idx" ON "groups" USING btree ("name");--> statement-breakpoint
CREATE INDEX "groups_status_idx" ON "groups" USING btree ("status");--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_key_credentials" ADD CONSTRAINT "hub_key_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_keys" ADD CONSTRAINT "hub_keys_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_keys" ADD CONSTRAINT "hub_keys_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_keys" ADD CONSTRAINT "hub_keys_secret_updated_by_users_id_fk" FOREIGN KEY ("secret_updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_control_operations" ADD CONSTRAINT "upstream_control_operations_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD CONSTRAINT "usage_rollups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD CONSTRAINT "usage_rollups_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_idx" ON "users" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_role_status_idx" ON "users" USING btree ("role","status");--> statement-breakpoint
CREATE INDEX "hub_keys_owner_group_idx" ON "hub_keys" USING btree ("owner_user_id","group_id");--> statement-breakpoint
CREATE INDEX "request_logs_user_created_idx" ON "request_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "request_logs_group_created_idx" ON "request_logs" USING btree ("group_id","created_at");--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD CONSTRAINT "usage_rollups_dimensions_unique" UNIQUE NULLS NOT DISTINCT("bucket_start","granularity","key_id","user_id","group_id","model","endpoint","status","channel_id");
