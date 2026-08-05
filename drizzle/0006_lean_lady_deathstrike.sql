ALTER TABLE "usage_rollups" ADD COLUMN "latency_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "latency_le_100" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "latency_le_250" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "latency_le_500" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "latency_le_1000" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "latency_le_2500" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "latency_le_5000" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "latency_le_10000" bigint DEFAULT 0 NOT NULL;