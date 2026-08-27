CREATE TABLE "channel_model_prices" (
	"channel_model_id" uuid PRIMARY KEY NOT NULL,
	"input_per_million" numeric(20, 8),
	"output_per_million" numeric(20, 8),
	"cached_per_million" numeric(20, 8),
	"reasoning_per_million" numeric(20, 8),
	"currency" text DEFAULT 'USD' NOT NULL,
	"unit" text DEFAULT 'per_million_tokens' NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_model_route_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"requested_model" text NOT NULL,
	"substitution_enabled" boolean DEFAULT false NOT NULL,
	"ordered_substitute_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_model_source_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"requested_model" text NOT NULL,
	"actual_model" text NOT NULL,
	"order_mode" text DEFAULT 'manual' NOT NULL,
	"ordered_source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_models" ADD COLUMN "canonical_model" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_models" ADD COLUMN "vendor_family" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_models" ADD COLUMN "model_revision" text;--> statement-breakpoint
ALTER TABLE "channel_models" ADD COLUMN "mapping_kind" text DEFAULT 'identity' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_protocol_bindings" ADD COLUMN "capability_mode" text DEFAULT 'native' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_protocol_bindings" ADD COLUMN "detected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "provider_preset_id" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "provider_family" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "product_type" text DEFAULT 'generic' NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "model_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "user_route_preferences" ADD COLUMN "radar_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_route_preferences" ADD COLUMN "radar_max_effort" text DEFAULT 'high' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_model_prices" ADD CONSTRAINT "channel_model_prices_channel_model_id_channel_models_id_fk" FOREIGN KEY ("channel_model_id") REFERENCES "public"."channel_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_model_route_policies" ADD CONSTRAINT "user_model_route_policies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_model_source_preferences" ADD CONSTRAINT "user_model_source_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_model_prices_fetched_idx" ON "channel_model_prices" USING btree ("fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_model_route_policies_user_model_idx" ON "user_model_route_policies" USING btree ("user_id","requested_model");--> statement-breakpoint
CREATE INDEX "user_model_route_policies_user_idx" ON "user_model_route_policies" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_model_source_preferences_route_idx" ON "user_model_source_preferences" USING btree ("user_id","requested_model","actual_model");--> statement-breakpoint
CREATE INDEX "user_model_source_preferences_user_idx" ON "user_model_source_preferences" USING btree ("user_id");
--> statement-breakpoint
UPDATE "channel_models"
SET "canonical_model" = regexp_replace("upstream_model", '^(openai|anthropic|google|zhipuai|zai-org|zai|deepseek|moonshot|qwen|alibaba|xai|minimax|doubao)/', '', 'i'),
    "mapping_kind" = CASE
      WHEN lower("public_model") = lower("upstream_model") THEN 'identity'
      WHEN lower(regexp_replace("public_model", '^(openai|anthropic|google|zhipuai|zai-org|zai|deepseek|moonshot|qwen|alibaba|xai|minimax|doubao)/', '', 'i')) = lower(regexp_replace("upstream_model", '^(openai|anthropic|google|zhipuai|zai-org|zai|deepseek|moonshot|qwen|alibaba|xai|minimax|doubao)/', '', 'i')) THEN 'alias'
      ELSE 'substitution'
    END;
--> statement-breakpoint
INSERT INTO "probe_model_catalog" ("vendor", "protocol", "endpoint", "model", "display_name", "sort_order") VALUES
	('Zhipu', 'openai_responses', '/v1/responses', 'glm-5.3', 'GLM-5.3', 10),
	('Zhipu', 'openai_chat', '/v1/chat/completions', 'glm-5.3', 'GLM-5.3', 10),
	('Doubao', 'openai_responses', '/v1/responses', 'doubao-seed-2-1-pro-260628', 'Doubao Seed 2.1 Pro', 10),
	('MiniMax', 'openai_responses', '/v1/responses', 'MiniMax-M3', 'MiniMax M3', 10),
	('MiniMax', 'openai_chat', '/v1/chat/completions', 'MiniMax-M3', 'MiniMax M3', 10)
ON CONFLICT ("protocol", "model") DO UPDATE SET
	"vendor" = EXCLUDED."vendor",
	"endpoint" = EXCLUDED."endpoint",
	"display_name" = EXCLUDED."display_name",
	"enabled" = true,
	"updated_at" = now();
