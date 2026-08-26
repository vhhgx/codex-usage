CREATE TEMP TABLE "_user_relay_group_merge" ON COMMIT DROP AS
WITH normalized AS (
	SELECT
		"id",
		"owner_user_id",
		"platform_type",
		"created_at",
		trim(regexp_replace("name", '\s*[-—–]\s*[^-—–]+$', '')) AS "canonical_name"
	FROM "user_relay_groups"
), ranked AS (
	SELECT
		*,
		first_value("id") OVER (
			PARTITION BY "owner_user_id", "platform_type", lower("canonical_name")
			ORDER BY "created_at", "id"
		) AS "target_id",
		count(*) OVER (
			PARTITION BY "owner_user_id", "platform_type", lower("canonical_name")
		) AS "group_count"
	FROM normalized
	WHERE length("canonical_name") >= 2
)
SELECT "id" AS "source_id", "target_id", "canonical_name"
FROM ranked
WHERE "group_count" > 1 AND "id" <> "target_id";--> statement-breakpoint

UPDATE "user_relay_groups" target
SET "name" = merged."canonical_name", "updated_at" = now()
FROM (
	SELECT DISTINCT "target_id", "canonical_name"
	FROM "_user_relay_group_merge"
) merged
WHERE target."id" = merged."target_id";--> statement-breakpoint

UPDATE "channels" channel
SET "user_relay_group_id" = merged."target_id", "updated_at" = now()
FROM "_user_relay_group_merge" merged
WHERE channel."user_relay_group_id" = merged."source_id";--> statement-breakpoint

UPDATE "channels" channel
SET "account_label" = trim(regexp_replace(channel."name", '^.*[-—–]\s*', '')), "updated_at" = now()
WHERE channel."user_relay_group_id" IN (SELECT DISTINCT "target_id" FROM "_user_relay_group_merge")
	AND channel."account_label" = channel."name"
	AND channel."name" ~ '[-—–]';--> statement-breakpoint

WITH ranked_accounts AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "user_relay_group_id"
			ORDER BY "account_rank", "created_at", "id"
		) * 10 AS "next_rank"
	FROM "channels"
	WHERE "user_relay_group_id" IN (SELECT DISTINCT "target_id" FROM "_user_relay_group_merge")
)
UPDATE "channels" channel
SET "account_rank" = ranked_accounts."next_rank", "updated_at" = now()
FROM ranked_accounts
WHERE channel."id" = ranked_accounts."id";--> statement-breakpoint

UPDATE "request_attempts" attempt
SET
	"user_relay_group_id" = merged."target_id",
	"resource_id" = CASE
		WHEN attempt."resource_type" = 'user_relay' AND attempt."resource_id" = merged."source_id" THEN merged."target_id"
		ELSE attempt."resource_id"
	END
FROM "_user_relay_group_merge" merged
WHERE attempt."user_relay_group_id" = merged."source_id"
	OR (attempt."resource_type" = 'user_relay' AND attempt."resource_id" = merged."source_id");--> statement-breakpoint

UPDATE "request_logs" log
SET
	"user_relay_group_id" = merged."target_id",
	"resource_id" = CASE
		WHEN log."resource_type" = 'user_relay' AND log."resource_id" = merged."source_id" THEN merged."target_id"
		ELSE log."resource_id"
	END
FROM "_user_relay_group_merge" merged
WHERE log."user_relay_group_id" = merged."source_id"
	OR (log."resource_type" = 'user_relay' AND log."resource_id" = merged."source_id");--> statement-breakpoint

UPDATE "user_route_preferences" preference
SET "ordered_source_ids" = COALESCE((
	SELECT jsonb_agg(to_jsonb(deduplicated."source_id") ORDER BY deduplicated."first_position")
	FROM (
		SELECT
			COALESCE('relay_group:' || merged."target_id"::text, item."source_id") AS "source_id",
			min(item."position") AS "first_position"
		FROM jsonb_array_elements_text(preference."ordered_source_ids") WITH ORDINALITY AS item("source_id", "position")
		LEFT JOIN "_user_relay_group_merge" merged
			ON item."source_id" = 'relay_group:' || merged."source_id"::text
		GROUP BY COALESCE('relay_group:' || merged."target_id"::text, item."source_id")
	) deduplicated
), '[]'::jsonb), "updated_at" = now()
WHERE EXISTS (
	SELECT 1
	FROM jsonb_array_elements_text(preference."ordered_source_ids") item("source_id")
	JOIN "_user_relay_group_merge" merged
		ON item."source_id" = 'relay_group:' || merged."source_id"::text
);--> statement-breakpoint

DELETE FROM "user_relay_groups" source
USING "_user_relay_group_merge" merged
WHERE source."id" = merged."source_id";
