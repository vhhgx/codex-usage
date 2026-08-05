CREATE TABLE "hub_key_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_last_four" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"locked_until" timestamp with time zone NOT NULL,
	"response_status" integer,
	"response_content_type" text,
	"response_body_object" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hub_keys" ADD COLUMN "max_request_tokens" bigint;--> statement-breakpoint
ALTER TABLE "hub_keys" ADD COLUMN "max_request_cost" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "hub_keys" ADD COLUMN "max_image_count" integer;--> statement-breakpoint
ALTER TABLE "hub_keys" ADD COLUMN "allowed_image_sizes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "hub_keys" ADD COLUMN "allowed_image_qualities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "hub_key_credentials" ADD CONSTRAINT "hub_key_credentials_key_id_hub_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."hub_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_key_id_hub_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."hub_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hub_key_credentials_hash_idx" ON "hub_key_credentials" USING btree ("key_hash");--> statement-breakpoint
INSERT INTO "hub_key_credentials" ("key_id", "key_hash", "key_prefix", "key_last_four", "status", "last_used_at", "created_at", "updated_at")
SELECT "id", "key_hash", "key_prefix", "key_last_four", CASE WHEN "status" = 'active' THEN 'active' ELSE 'revoked' END, "last_used_at", "created_at", "updated_at"
FROM "hub_keys"
ON CONFLICT ("key_hash") DO NOTHING;--> statement-breakpoint
CREATE INDEX "hub_key_credentials_key_status_idx" ON "hub_key_credentials" USING btree ("key_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_key_endpoint_idx" ON "idempotency_records" USING btree ("key_id","endpoint","idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "idempotency_updated_idx" ON "idempotency_records" USING btree ("updated_at");
