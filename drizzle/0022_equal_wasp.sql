ALTER TABLE "account_vault_entries" ADD COLUMN "sms_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_vault_entries" ADD COLUMN "sub2api_pool_status" text DEFAULT 'not_added' NOT NULL;--> statement-breakpoint
ALTER TABLE "account_vault_entries" ADD COLUMN "sub2api_removed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "account_vault_sub2api_pool_status_idx" ON "account_vault_entries" USING btree ("sub2api_pool_status");--> statement-breakpoint
UPDATE "account_vault_entries" AS "account"
SET "sms_verified_at" = "verified"."code_received_at"
FROM (
  SELECT "account_id", max("code_received_at") AS "code_received_at"
  FROM "sms_receiver_bindings"
  WHERE "account_id" IS NOT NULL AND "code_received_at" IS NOT NULL
  GROUP BY "account_id"
) AS "verified"
WHERE "account"."id" = "verified"."account_id";--> statement-breakpoint
UPDATE "account_vault_entries"
SET "sub2api_pool_status" = 'active'
WHERE "sub2api_account_id" IS NOT NULL;
