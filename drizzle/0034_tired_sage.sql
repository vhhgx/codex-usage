CREATE TYPE "public"."relay_account_order_mode" AS ENUM('manual', 'balance_asc', 'balance_desc');--> statement-breakpoint
CREATE TYPE "public"."relay_account_routing_state" AS ENUM('active', 'depleted', 'credential_error', 'manual_disabled');--> statement-breakpoint
CREATE TYPE "public"."relay_balance_status" AS ENUM('unknown', 'success', 'error');--> statement-breakpoint
CREATE TYPE "public"."relay_platform_type" AS ENUM('generic', 'newapi', 'sub2api');--> statement-breakpoint
CREATE TYPE "public"."request_resource_type" AS ENUM('subscription', 'user_relay', 'private_pool', 'unresolved');--> statement-breakpoint
ALTER TYPE "public"."protocol_verification_status" ADD VALUE 'pending_real_client' BEFORE 'failed';--> statement-breakpoint
CREATE TABLE "user_relay_account_states" (
	"channel_id" uuid PRIMARY KEY NOT NULL,
	"routing_state" "relay_account_routing_state" DEFAULT 'active' NOT NULL,
	"state_reason_code" text,
	"state_reason_message" text,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_quota" numeric(20, 8),
	"purchased_quota" numeric(20, 8),
	"gift_quota" numeric(20, 8),
	"used_quota" numeric(20, 8),
	"remaining_balance" numeric(20, 8),
	"currency" text,
	"balance_source" text,
	"balance_status" "relay_balance_status" DEFAULT 'unknown' NOT NULL,
	"balance_fetched_at" timestamp with time zone,
	"balance_error" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_relay_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"homepage_url" text,
	"normalized_origin" text,
	"platform_type" "relay_platform_type" DEFAULT 'generic' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"account_order_mode" "relay_account_order_mode" DEFAULT 'manual' NOT NULL,
	"max_concurrency" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "user_relay_group_id" uuid;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "account_label" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "account_rank" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "insecure_http_acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "request_attempts" ADD COLUMN "user_relay_group_id" uuid;--> statement-breakpoint
ALTER TABLE "request_attempts" ADD COLUMN "resource_type" "request_resource_type";--> statement-breakpoint
ALTER TABLE "request_attempts" ADD COLUMN "resource_id" uuid;--> statement-breakpoint
ALTER TABLE "request_attempts" ADD COLUMN "resource_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "request_attempts" ADD COLUMN "execution_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "request_attempts" ADD COLUMN "failure_class" text;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "resource_type" "request_resource_type" DEFAULT 'unresolved' NOT NULL;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "resource_id" uuid;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "resource_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "execution_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "user_relay_group_id" uuid;--> statement-breakpoint
ALTER TABLE "user_relay_account_states" ADD CONSTRAINT "user_relay_account_states_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_relay_groups" ADD CONSTRAINT "user_relay_groups_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "user_relay_groups" (
	"id", "owner_user_id", "name", "homepage_url", "normalized_origin", "platform_type", "enabled", "account_order_mode", "created_at", "updated_at"
)
SELECT
	"id", "owner_user_id", "name", "base_url", lower(substring("base_url" from '^[A-Za-z][A-Za-z0-9+.-]*://[^/]+')), CASE WHEN "type" = 'sub2api' THEN 'sub2api'::"relay_platform_type" WHEN "encrypted_checkin_token" IS NOT NULL OR "checkin_enabled" = true THEN 'newapi'::"relay_platform_type" ELSE 'generic'::"relay_platform_type" END,
	"enabled", 'manual'::"relay_account_order_mode", "created_at", "updated_at"
FROM "channels"
WHERE "owner_kind" = 'user' AND "owner_user_id" IS NOT NULL;--> statement-breakpoint
UPDATE "channels"
SET "user_relay_group_id" = "id", "account_label" = COALESCE(NULLIF("name", ''), '账号 1'), "account_rank" = "priority"
WHERE "owner_kind" = 'user' AND "owner_user_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO "user_relay_account_states" ("channel_id")
SELECT "id" FROM "channels" WHERE "owner_kind" = 'user'
ON CONFLICT ("channel_id") DO NOTHING;--> statement-breakpoint
UPDATE "user_route_preferences" preference
SET "ordered_source_ids" = COALESCE((
	SELECT jsonb_agg(to_jsonb(CASE WHEN value LIKE 'relay:%' THEN 'relay_group:' || substr(value, 7) ELSE value END) ORDER BY ordinal)
	FROM jsonb_array_elements_text(preference."ordered_source_ids") WITH ORDINALITY AS item(value, ordinal)
), '[]'::jsonb);--> statement-breakpoint
UPDATE "request_logs" log
SET
	"resource_type" = CASE log."supply_source"
		WHEN 'platform' THEN 'subscription'::"request_resource_type"
		WHEN 'user_relay' THEN 'user_relay'::"request_resource_type"
		WHEN 'private_pool' THEN 'private_pool'::"request_resource_type"
		ELSE 'unresolved'::"request_resource_type"
	END,
	"resource_id" = CASE log."supply_source"
		WHEN 'platform' THEN log."subscription_id"
		WHEN 'user_relay' THEN log."channel_id"
		WHEN 'private_pool' THEN log."pool_group_id"
		ELSE NULL
	END,
	"user_relay_group_id" = CASE WHEN log."supply_source" = 'user_relay' THEN log."channel_id" ELSE NULL END,
	"resource_name_snapshot" = CASE
		WHEN log."supply_source" = 'user_relay' THEN (SELECT channel."name" FROM "channels" channel WHERE channel."id" = log."channel_id")
		WHEN log."supply_source" = 'private_pool' THEN (SELECT pool."display_name" FROM "user_pool_groups" pool WHERE pool."id" = log."pool_group_id")
		WHEN log."supply_source" = 'platform' THEN (SELECT plan."name" FROM "user_subscriptions" subscription JOIN "service_plans" plan ON plan."id" = subscription."plan_id" WHERE subscription."id" = log."subscription_id")
		ELSE NULL
	END,
	"execution_name_snapshot" = (SELECT channel."name" FROM "channels" channel WHERE channel."id" = log."channel_id");--> statement-breakpoint
CREATE INDEX "user_relay_account_states_routing_idx" ON "user_relay_account_states" USING btree ("routing_state");--> statement-breakpoint
CREATE INDEX "user_relay_account_states_balance_idx" ON "user_relay_account_states" USING btree ("balance_status","remaining_balance");--> statement-breakpoint
CREATE INDEX "user_relay_groups_owner_idx" ON "user_relay_groups" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "user_relay_groups_owner_enabled_idx" ON "user_relay_groups" USING btree ("owner_user_id","enabled");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_user_relay_group_id_user_relay_groups_id_fk" FOREIGN KEY ("user_relay_group_id") REFERENCES "public"."user_relay_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_attempts" ADD CONSTRAINT "request_attempts_user_relay_group_id_user_relay_groups_id_fk" FOREIGN KEY ("user_relay_group_id") REFERENCES "public"."user_relay_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_user_relay_group_id_user_relay_groups_id_fk" FOREIGN KEY ("user_relay_group_id") REFERENCES "public"."user_relay_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channels_relay_group_rank_idx" ON "channels" USING btree ("user_relay_group_id","account_rank");--> statement-breakpoint
ALTER TABLE "channels" DROP COLUMN "model_discovery_enabled";
