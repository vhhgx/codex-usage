CREATE TABLE "system_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"body_retention_days" integer DEFAULT 30 NOT NULL,
	"metadata_retention_days" integer DEFAULT 365 NOT NULL,
	"default_timeout_ms" integer DEFAULT 120000 NOT NULL,
	"circuit_failure_threshold" integer DEFAULT 3 NOT NULL,
	"circuit_cooldown_ms" integer DEFAULT 30000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
