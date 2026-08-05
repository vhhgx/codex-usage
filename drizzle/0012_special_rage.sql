CREATE TABLE "account_vault_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"status" text DEFAULT 'Codex' NOT NULL,
	"encrypted_password" text NOT NULL,
	"purchase_date" text,
	"warranty_date" text,
	"warranty_status" text DEFAULT '有质保' NOT NULL,
	"sms_url" text,
	"phone" text,
	"remark" text,
	"source_ref" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_on" text NOT NULL,
	"type" text NOT NULL,
	"project" text DEFAULT '' NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"quantity" integer NOT NULL,
	"amount_cents" bigint NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"source_ref" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_vault_entries" ADD CONSTRAINT "account_vault_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_vault_entries" ADD CONSTRAINT "account_vault_entries_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_vault_email_idx" ON "account_vault_entries" USING btree ("email");--> statement-breakpoint
CREATE INDEX "account_vault_status_idx" ON "account_vault_entries" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "account_vault_source_ref_idx" ON "account_vault_entries" USING btree ("source_ref");--> statement-breakpoint
CREATE INDEX "ledger_transactions_occurred_idx" ON "ledger_transactions" USING btree ("occurred_on");--> statement-breakpoint
CREATE INDEX "ledger_transactions_type_idx" ON "ledger_transactions" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transactions_source_ref_idx" ON "ledger_transactions" USING btree ("source_ref");