CREATE TABLE "probe_model_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor" text NOT NULL,
	"protocol" "channel_protocol" NOT NULL,
	"endpoint" text NOT NULL,
	"model" text NOT NULL,
	"display_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "probe_model_catalog_protocol_model_idx" ON "probe_model_catalog" USING btree ("protocol","model");--> statement-breakpoint
CREATE INDEX "probe_model_catalog_protocol_enabled_idx" ON "probe_model_catalog" USING btree ("protocol","enabled","sort_order");--> statement-breakpoint
INSERT INTO "probe_model_catalog" ("vendor", "protocol", "endpoint", "model", "display_name", "sort_order") VALUES
	('Anthropic', 'anthropic_messages', '/v1/messages', 'claude-opus-5', 'Claude Opus 5', 10),
	('Anthropic', 'anthropic_messages', '/v1/messages', 'claude-sonnet-5', 'Claude Sonnet 5', 20),
	('Anthropic', 'anthropic_messages', '/v1/messages', 'claude-haiku-4.5', 'Claude Haiku 4.5', 30),
	('OpenAI', 'openai_responses', '/v1/responses', 'gpt-5.6', 'GPT-5.6', 10),
	('OpenAI', 'openai_responses', '/v1/responses', 'gpt-5.6-sol', 'GPT-5.6 Sol', 20),
	('OpenAI', 'openai_responses', '/v1/responses', 'gpt-5.6-terra', 'GPT-5.6 Terra', 30),
	('OpenAI', 'openai_responses', '/v1/responses', 'gpt-5.6-luna', 'GPT-5.6 Luna', 40),
	('OpenAI', 'openai_chat', '/v1/chat/completions', 'gpt-5.6', 'GPT-5.6', 10),
	('OpenAI', 'openai_chat', '/v1/chat/completions', 'gpt-5.6-sol', 'GPT-5.6 Sol', 20),
	('xAI', 'openai_responses', '/v1/responses', 'grok-4.5', 'Grok 4.5', 50),
	('xAI', 'openai_chat', '/v1/chat/completions', 'grok-4.5', 'Grok 4.5', 50),
	('Google', 'openai_chat', '/v1/chat/completions', 'gemini-3.6-flash', 'Gemini 3.6 Flash', 60),
	('Moonshot AI', 'openai_chat', '/v1/chat/completions', 'kimi-k2.7-code', 'Kimi K2.7 Code', 70),
	('DeepSeek', 'openai_chat', '/v1/chat/completions', 'deepseek-v4-pro', 'DeepSeek V4 Pro', 80),
	('Zhipu AI', 'openai_chat', '/v1/chat/completions', 'glm-5.1', 'GLM-5.1', 90)
ON CONFLICT ("protocol", "model") DO NOTHING;
