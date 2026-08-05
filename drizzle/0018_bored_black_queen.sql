ALTER TABLE "account_vault_entries" ADD COLUMN "encrypted_access_token" text;--> statement-breakpoint
ALTER TABLE "account_vault_entries" ADD COLUMN "encrypted_refresh_token" text;--> statement-breakpoint
ALTER TABLE "account_vault_entries" ADD COLUMN "encrypted_email_code_url" text;--> statement-breakpoint
ALTER TABLE "sms_receiver_bindings" ADD COLUMN "code_received_at" timestamp with time zone;