CREATE TYPE "public"."channel_access_scope" AS ENUM('all', 'restricted', 'private');--> statement-breakpoint
CREATE TYPE "public"."channel_auth_scheme" AS ENUM('bearer', 'x_api_key');--> statement-breakpoint
CREATE TYPE "public"."channel_owner_kind" AS ENUM('platform', 'user');--> statement-breakpoint
CREATE TYPE "public"."channel_protocol" AS ENUM('anthropic_messages', 'openai_responses', 'openai_chat');--> statement-breakpoint
CREATE TYPE "public"."key_route_mode" AS ENUM('platform_only', 'private_only', 'platform_then_private', 'private_then_platform');--> statement-breakpoint
CREATE TYPE "public"."protocol_conversion_mode" AS ENUM('passthrough', 'anthropic_to_openai', 'openai_to_anthropic');--> statement-breakpoint
CREATE TYPE "public"."protocol_verification_status" AS ENUM('unknown', 'verified', 'failed');--> statement-breakpoint
ALTER TYPE "public"."channel_type" ADD VALUE 'anthropic_compatible';--> statement-breakpoint
CREATE TABLE "channel_group_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_model_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_model_id" uuid NOT NULL,
	"protocol_binding_id" uuid NOT NULL,
	"upstream_model" text NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_protocol_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"protocol" "channel_protocol" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"base_url_override" text,
	"auth_scheme" "channel_auth_scheme" DEFAULT 'bearer' NOT NULL,
	"api_version" text,
	"adapter_options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verification_status" "protocol_verification_status" DEFAULT 'unknown' NOT NULL,
	"verified_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_user_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "key_channel_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_rollups" DROP CONSTRAINT "usage_rollups_dimensions_unique";--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "owner_kind" "channel_owner_kind" DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "access_scope" "channel_access_scope" DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "credential_key_version" text;--> statement-breakpoint
ALTER TABLE "hub_keys" ADD COLUMN "route_mode" "key_route_mode" DEFAULT 'platform_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "request_attempts" ADD COLUMN "protocol_binding_id" uuid;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "protocol_binding_id" uuid;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "inbound_protocol" "channel_protocol";--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "outbound_protocol" "channel_protocol";--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "conversion_mode" "protocol_conversion_mode" DEFAULT 'passthrough' NOT NULL;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "source_owner_kind" "channel_owner_kind";--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "source_owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "cache_creation_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "cache_affinity_reused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "protocol_binding_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "protocol" "channel_protocol";--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "cached_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "cache_creation_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "affinity_reuses" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_group_grants" ADD CONSTRAINT "channel_group_grants_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_group_grants" ADD CONSTRAINT "channel_group_grants_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_group_grants" ADD CONSTRAINT "channel_group_grants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_model_bindings" ADD CONSTRAINT "channel_model_bindings_channel_model_id_channel_models_id_fk" FOREIGN KEY ("channel_model_id") REFERENCES "public"."channel_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_model_bindings" ADD CONSTRAINT "channel_model_bindings_protocol_binding_id_channel_protocol_bindings_id_fk" FOREIGN KEY ("protocol_binding_id") REFERENCES "public"."channel_protocol_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_protocol_bindings" ADD CONSTRAINT "channel_protocol_bindings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_user_grants" ADD CONSTRAINT "channel_user_grants_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_user_grants" ADD CONSTRAINT "channel_user_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_user_grants" ADD CONSTRAINT "channel_user_grants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_channel_rules" ADD CONSTRAINT "key_channel_rules_key_id_hub_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."hub_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_channel_rules" ADD CONSTRAINT "key_channel_rules_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_group_grants_channel_group_idx" ON "channel_group_grants" USING btree ("channel_id","group_id");--> statement-breakpoint
CREATE INDEX "channel_group_grants_group_idx" ON "channel_group_grants" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_model_bindings_model_protocol_idx" ON "channel_model_bindings" USING btree ("channel_model_id","protocol_binding_id");--> statement-breakpoint
CREATE INDEX "channel_model_bindings_protocol_idx" ON "channel_model_bindings" USING btree ("protocol_binding_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_protocol_bindings_channel_protocol_idx" ON "channel_protocol_bindings" USING btree ("channel_id","protocol");--> statement-breakpoint
CREATE INDEX "channel_protocol_bindings_enabled_idx" ON "channel_protocol_bindings" USING btree ("protocol","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_user_grants_channel_user_idx" ON "channel_user_grants" USING btree ("channel_id","user_id");--> statement-breakpoint
CREATE INDEX "channel_user_grants_user_idx" ON "channel_user_grants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "key_channel_rules_key_channel_idx" ON "key_channel_rules" USING btree ("key_id","channel_id");--> statement-breakpoint
CREATE INDEX "key_channel_rules_channel_idx" ON "key_channel_rules" USING btree ("channel_id");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_attempts" ADD CONSTRAINT "request_attempts_protocol_binding_id_channel_protocol_bindings_id_fk" FOREIGN KEY ("protocol_binding_id") REFERENCES "public"."channel_protocol_bindings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_protocol_binding_id_channel_protocol_bindings_id_fk" FOREIGN KEY ("protocol_binding_id") REFERENCES "public"."channel_protocol_bindings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_source_owner_user_id_users_id_fk" FOREIGN KEY ("source_owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD CONSTRAINT "usage_rollups_protocol_binding_id_channel_protocol_bindings_id_fk" FOREIGN KEY ("protocol_binding_id") REFERENCES "public"."channel_protocol_bindings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
INSERT INTO "channel_protocol_bindings" ("channel_id", "protocol", "auth_scheme", "verification_status")
SELECT "id", 'openai_chat', 'bearer', 'unknown' FROM "channels"
ON CONFLICT ("channel_id", "protocol") DO NOTHING;--> statement-breakpoint
INSERT INTO "channel_protocol_bindings" ("channel_id", "protocol", "auth_scheme", "verification_status")
SELECT "id", 'openai_responses', 'bearer', 'unknown' FROM "channels"
ON CONFLICT ("channel_id", "protocol") DO NOTHING;--> statement-breakpoint
INSERT INTO "channel_model_bindings" ("channel_model_id", "protocol_binding_id", "upstream_model", "capabilities", "enabled")
SELECT m."id", p."id", m."upstream_model", '{"streaming":true,"tools":true}'::jsonb, m."enabled"
FROM "channel_models" m
JOIN "channel_protocol_bindings" p ON p."channel_id" = m."channel_id"
ON CONFLICT ("channel_model_id", "protocol_binding_id") DO NOTHING;--> statement-breakpoint
CREATE INDEX "channels_owner_idx" ON "channels" USING btree ("owner_kind","owner_user_id");--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD CONSTRAINT "usage_rollups_dimensions_unique" UNIQUE NULLS NOT DISTINCT("bucket_start","granularity","key_id","user_id","group_id","model","endpoint","status","channel_id","protocol_binding_id","protocol","supply_source","pool_group_id","subscription_id","plan_version_id");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_owner_scope_check" CHECK ((
    ("channels"."owner_kind" = 'platform' AND "channels"."owner_user_id" IS NULL AND "channels"."access_scope" IN ('all', 'restricted'))
    OR
    ("channels"."owner_kind" = 'user' AND "channels"."owner_user_id" IS NOT NULL AND "channels"."access_scope" = 'private')
  ));
