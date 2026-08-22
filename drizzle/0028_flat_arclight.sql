ALTER TABLE "usage_rollups" ADD COLUMN "cache_hit_requests" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "cache_eligible_requests" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "affinity_failovers" bigint DEFAULT 0 NOT NULL;