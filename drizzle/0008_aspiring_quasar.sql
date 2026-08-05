ALTER TABLE "usage_rollups" ADD COLUMN "admitted_requests" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "usage_rollups" SET "admitted_requests" = "requests";
