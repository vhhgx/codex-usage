CREATE TYPE "public"."channel_type" AS ENUM('cpa', 'sub2api');--> statement-breakpoint
CREATE TYPE "public"."hub_key_status" AS ENUM('active', 'disabled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('pending', 'success', 'error', 'stream_aborted');--> statement-breakpoint
CREATE TYPE "public"."routing_strategy" AS ENUM('priority', 'weighted_round_robin');--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"admin_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"public_model" text NOT NULL,
	"upstream_model" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"endpoints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" "channel_type" NOT NULL,
	"base_url" text NOT NULL,
	"encrypted_api_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"max_concurrency" integer DEFAULT 20 NOT NULL,
	"timeout_ms" integer DEFAULT 120000 NOT NULL,
	"price_multiplier" numeric(12, 6) DEFAULT '1' NOT NULL,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"last_health_check_at" timestamp with time zone,
	"last_health_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hub_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"note" text,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_last_four" text NOT NULL,
	"status" "hub_key_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"allowed_endpoints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rpm_limit" integer,
	"concurrency_limit" integer,
	"total_request_limit" bigint,
	"total_token_limit" bigint,
	"total_cost_limit" numeric(20, 8),
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
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "key_model_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" uuid NOT NULL,
	"public_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_model" text NOT NULL,
	"strategy" "routing_strategy" DEFAULT 'priority' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_model" text NOT NULL,
	"input_per_million" numeric(20, 8) DEFAULT '0' NOT NULL,
	"output_per_million" numeric(20, 8) DEFAULT '0' NOT NULL,
	"cached_per_million" numeric(20, 8) DEFAULT '0' NOT NULL,
	"reasoning_per_million" numeric(20, 8) DEFAULT '0' NOT NULL,
	"image_prices" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"request_log_id" uuid NOT NULL,
	"channel_id" uuid,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"http_status" integer,
	"duration_ms" integer,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" text NOT NULL,
	"key_id" uuid,
	"endpoint" text NOT NULL,
	"requested_model" text,
	"upstream_model" text,
	"channel_id" uuid,
	"status" "request_status" DEFAULT 'pending' NOT NULL,
	"http_status" integer,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_tokens" bigint DEFAULT 0 NOT NULL,
	"reasoning_tokens" bigint DEFAULT 0 NOT NULL,
	"total_tokens" bigint DEFAULT 0 NOT NULL,
	"image_count" integer DEFAULT 0 NOT NULL,
	"cost" numeric(20, 8) DEFAULT '0' NOT NULL,
	"first_byte_ms" integer,
	"duration_ms" integer,
	"streaming" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"error_message" text,
	"client_ip_hash" text,
	"request_body_object" text,
	"response_body_object" text,
	"body_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "usage_rollups" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"granularity" text NOT NULL,
	"key_id" uuid,
	"model" text,
	"channel_id" uuid,
	"requests" bigint DEFAULT 0 NOT NULL,
	"successes" bigint DEFAULT 0 NOT NULL,
	"failures" bigint DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"total_tokens" bigint DEFAULT 0 NOT NULL,
	"cost" numeric(20, 8) DEFAULT '0' NOT NULL,
	"duration_ms" bigint DEFAULT 0 NOT NULL,
	"failovers" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_admin_id_admin_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_models" ADD CONSTRAINT "channel_models_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_model_rules" ADD CONSTRAINT "key_model_rules_key_id_hub_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."hub_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_attempts" ADD CONSTRAINT "request_attempts_request_log_id_request_logs_id_fk" FOREIGN KEY ("request_log_id") REFERENCES "public"."request_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_attempts" ADD CONSTRAINT "request_attempts_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_key_id_hub_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."hub_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_logs" ADD CONSTRAINT "request_logs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD CONSTRAINT "usage_rollups_key_id_hub_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."hub_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD CONSTRAINT "usage_rollups_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_username_idx" ON "admin_users" USING btree ("username");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_models_channel_public_idx" ON "channel_models" USING btree ("channel_id","public_model");--> statement-breakpoint
CREATE INDEX "channel_models_public_enabled_idx" ON "channel_models" USING btree ("public_model","enabled");--> statement-breakpoint
CREATE INDEX "channels_enabled_priority_idx" ON "channels" USING btree ("enabled","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "hub_keys_hash_idx" ON "hub_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "hub_keys_status_idx" ON "hub_keys" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "key_model_rules_key_model_idx" ON "key_model_rules" USING btree ("key_id","public_model");--> statement-breakpoint
CREATE UNIQUE INDEX "model_pools_public_model_idx" ON "model_pools" USING btree ("public_model");--> statement-breakpoint
CREATE INDEX "model_prices_model_effective_idx" ON "model_prices" USING btree ("public_model","effective_at");--> statement-breakpoint
CREATE INDEX "request_attempts_log_idx" ON "request_attempts" USING btree ("request_log_id");--> statement-breakpoint
CREATE UNIQUE INDEX "request_logs_request_id_idx" ON "request_logs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "request_logs_created_idx" ON "request_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "request_logs_key_created_idx" ON "request_logs" USING btree ("key_id","created_at");--> statement-breakpoint
CREATE INDEX "request_logs_model_created_idx" ON "request_logs" USING btree ("requested_model","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_rollups_dimensions_idx" ON "usage_rollups" USING btree ("bucket_start","granularity","key_id","model","channel_id");