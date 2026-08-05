DROP INDEX "usage_rollups_dimensions_idx";--> statement-breakpoint
WITH "duplicates" AS (
	SELECT
		min("id") AS "keep_id",
		sum("requests") AS "requests",
		sum("successes") AS "successes",
		sum("failures") AS "failures",
		sum("input_tokens") AS "input_tokens",
		sum("output_tokens") AS "output_tokens",
		sum("total_tokens") AS "total_tokens",
		sum("cost") AS "cost",
		sum("duration_ms") AS "duration_ms",
		sum("latency_count") AS "latency_count",
		sum("latency_le_100") AS "latency_le_100",
		sum("latency_le_250") AS "latency_le_250",
		sum("latency_le_500") AS "latency_le_500",
		sum("latency_le_1000") AS "latency_le_1000",
		sum("latency_le_2500") AS "latency_le_2500",
		sum("latency_le_5000") AS "latency_le_5000",
		sum("latency_le_10000") AS "latency_le_10000",
		sum("failovers") AS "failovers"
	FROM "usage_rollups"
	GROUP BY "bucket_start", "granularity", "key_id", "model", "endpoint", "status", "channel_id"
	HAVING count(*) > 1
)
UPDATE "usage_rollups" AS "rollup" SET
	"requests" = "duplicates"."requests",
	"successes" = "duplicates"."successes",
	"failures" = "duplicates"."failures",
	"input_tokens" = "duplicates"."input_tokens",
	"output_tokens" = "duplicates"."output_tokens",
	"total_tokens" = "duplicates"."total_tokens",
	"cost" = "duplicates"."cost",
	"duration_ms" = "duplicates"."duration_ms",
	"latency_count" = "duplicates"."latency_count",
	"latency_le_100" = "duplicates"."latency_le_100",
	"latency_le_250" = "duplicates"."latency_le_250",
	"latency_le_500" = "duplicates"."latency_le_500",
	"latency_le_1000" = "duplicates"."latency_le_1000",
	"latency_le_2500" = "duplicates"."latency_le_2500",
	"latency_le_5000" = "duplicates"."latency_le_5000",
	"latency_le_10000" = "duplicates"."latency_le_10000",
	"failovers" = "duplicates"."failovers",
	"updated_at" = now()
FROM "duplicates"
WHERE "rollup"."id" = "duplicates"."keep_id";--> statement-breakpoint
DELETE FROM "usage_rollups" AS "rollup"
USING "usage_rollups" AS "keeper"
WHERE "rollup"."id" > "keeper"."id"
	AND "rollup"."bucket_start" = "keeper"."bucket_start"
	AND "rollup"."granularity" = "keeper"."granularity"
	AND "rollup"."key_id" IS NOT DISTINCT FROM "keeper"."key_id"
	AND "rollup"."model" IS NOT DISTINCT FROM "keeper"."model"
	AND "rollup"."endpoint" = "keeper"."endpoint"
	AND "rollup"."status" = "keeper"."status"
	AND "rollup"."channel_id" IS NOT DISTINCT FROM "keeper"."channel_id";--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD CONSTRAINT "usage_rollups_dimensions_unique" UNIQUE NULLS NOT DISTINCT("bucket_start","granularity","key_id","model","endpoint","status","channel_id");
