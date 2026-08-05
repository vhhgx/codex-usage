ALTER TABLE "request_logs" ADD COLUMN "request_body_hash" text;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "response_body_hash" text;