DROP INDEX "usage_rollups_dimensions_idx";--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "status" text DEFAULT 'success' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_rollups_dimensions_idx" ON "usage_rollups" USING btree ("bucket_start","granularity","key_id","model","endpoint","status","channel_id");