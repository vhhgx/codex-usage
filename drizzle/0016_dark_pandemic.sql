ALTER TABLE "sms_receiver_bindings" DROP CONSTRAINT "sms_receiver_bindings_account_id_account_vault_entries_id_fk";
--> statement-breakpoint
ALTER TABLE "sms_receiver_bindings" ALTER COLUMN "account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sms_receiver_bindings" ADD COLUMN "account_email" text;--> statement-breakpoint
ALTER TABLE "sms_receiver_bindings" ADD COLUMN "account_display_name" text;--> statement-breakpoint
ALTER TABLE "sms_receiver_bindings" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
UPDATE "sms_receiver_bindings" AS binding
SET "account_email" = account."email", "account_display_name" = account."display_name"
FROM "account_vault_entries" AS account
WHERE binding."account_id" = account."id";--> statement-breakpoint
ALTER TABLE "sms_receiver_bindings" ALTER COLUMN "account_email" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sms_receiver_bindings" ADD CONSTRAINT "sms_receiver_bindings_account_id_account_vault_entries_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account_vault_entries"("id") ON DELETE set null ON UPDATE no action;
