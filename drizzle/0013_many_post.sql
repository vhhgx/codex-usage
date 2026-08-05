CREATE TABLE "sms_receiver_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receiver_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"slot" integer NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_receivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"phone_key" text NOT NULL,
	"provider_host" text NOT NULL,
	"encrypted_fetch_url" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_fetch_status" text,
	"last_fetch_error" text,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sms_receiver_bindings" ADD CONSTRAINT "sms_receiver_bindings_receiver_id_sms_receivers_id_fk" FOREIGN KEY ("receiver_id") REFERENCES "public"."sms_receivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_receiver_bindings" ADD CONSTRAINT "sms_receiver_bindings_account_id_account_vault_entries_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account_vault_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_receiver_bindings" ADD CONSTRAINT "sms_receiver_bindings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_receivers" ADD CONSTRAINT "sms_receivers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_receivers" ADD CONSTRAINT "sms_receivers_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_receiver_bindings_account_idx" ON "sms_receiver_bindings" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_receiver_bindings_receiver_slot_idx" ON "sms_receiver_bindings" USING btree ("receiver_id","slot");--> statement-breakpoint
CREATE INDEX "sms_receiver_bindings_receiver_idx" ON "sms_receiver_bindings" USING btree ("receiver_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_receivers_phone_key_idx" ON "sms_receivers" USING btree ("phone_key");--> statement-breakpoint
CREATE INDEX "sms_receivers_status_idx" ON "sms_receivers" USING btree ("status");