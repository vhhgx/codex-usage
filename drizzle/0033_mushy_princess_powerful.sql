ALTER TABLE "channel_protocol_bindings" ADD COLUMN "probe_model" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "platform_access_expires_at" timestamp with time zone;