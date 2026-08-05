ALTER TABLE "account_vault_entries" ADD COLUMN "sub2api_account_id" text;--> statement-breakpoint
ALTER TABLE "account_vault_entries" ADD COLUMN "codex_added_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "account_vault_sub2api_account_idx" ON "account_vault_entries" USING btree ("sub2api_account_id");