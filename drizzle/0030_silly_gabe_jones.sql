DROP INDEX "sms_receivers_phone_key_idx";--> statement-breakpoint
ALTER TABLE "sms_receiver_bindings" ADD COLUMN "pool_account_id" uuid;--> statement-breakpoint
ALTER TABLE "sms_receivers" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "sms_receiver_bindings" ADD CONSTRAINT "sms_receiver_bindings_pool_account_id_user_pool_accounts_id_fk" FOREIGN KEY ("pool_account_id") REFERENCES "public"."user_pool_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_receivers" ADD CONSTRAINT "sms_receivers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_receiver_bindings_pool_account_idx" ON "sms_receiver_bindings" USING btree ("pool_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sms_receivers_platform_phone_key_idx" ON "sms_receivers" USING btree ("phone_key") WHERE "sms_receivers"."owner_user_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_receivers_owner_phone_key_idx" ON "sms_receivers" USING btree ("owner_user_id","phone_key") WHERE "sms_receivers"."owner_user_id" is not null;--> statement-breakpoint
CREATE INDEX "sms_receivers_owner_idx" ON "sms_receivers" USING btree ("owner_user_id");--> statement-breakpoint
ALTER TABLE "sms_receiver_bindings" ADD CONSTRAINT "sms_receiver_bindings_account_kind_check" CHECK (not ("sms_receiver_bindings"."account_id" is not null and "sms_receiver_bindings"."pool_account_id" is not null));