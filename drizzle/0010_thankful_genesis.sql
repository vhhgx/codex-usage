CREATE TYPE "public"."upstream_operation_status" AS ENUM('pending', 'succeeded', 'failed', 'reconciliation_required');--> statement-breakpoint
CREATE TABLE "upstream_control_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" text NOT NULL,
	"admin_id" uuid,
	"connection_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_ref" text,
	"idempotency_key_hash" text,
	"request_fingerprint" text NOT NULL,
	"status" "upstream_operation_status" DEFAULT 'pending' NOT NULL,
	"upstream_status" integer,
	"upstream_request_id" text,
	"safe_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "upstream_control_operations" ADD CONSTRAINT "upstream_control_operations_admin_id_admin_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "upstream_operations_started_idx" ON "upstream_control_operations" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "upstream_operations_status_idx" ON "upstream_control_operations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "upstream_operations_idempotency_idx" ON "upstream_control_operations" USING btree ("connection_id","action","idempotency_key_hash");