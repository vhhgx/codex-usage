DROP INDEX "usage_rollups_dimensions_idx";--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "endpoint" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_rollups_dimensions_idx" ON "usage_rollups" USING btree ("bucket_start","granularity","key_id","model","endpoint","channel_id");