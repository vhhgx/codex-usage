CREATE TYPE "public"."supply_source" AS ENUM('platform', 'private_pool', 'user_relay');--> statement-breakpoint
CREATE TYPE "public"."user_pool_status" AS ENUM('provisioning', 'active', 'disabled', 'error');--> statement-breakpoint
CREATE TYPE "public"."wallet_transaction_type" AS ENUM('recharge', 'hold', 'settle', 'release', 'refund', 'manual_adjustment');--> statement-breakpoint
ALTER TYPE "public"."channel_type" ADD VALUE 'openai_compatible';--> statement-breakpoint
CREATE TABLE "service_plan_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"billing_mode" text DEFAULT 'unlimited' NOT NULL,
	"supply_mode" text DEFAULT 'platform_only' NOT NULL,
	"cycle" text DEFAULT 'none' NOT NULL,
	"token_limit" bigint,
	"quota_unit" text DEFAULT 'raw_token' NOT NULL,
	"price" numeric(20, 8) DEFAULT '0' NOT NULL,
	"max_pool_accounts" integer,
	"private_usage_billing" text DEFAULT 'free' NOT NULL,
	"private_usage_rate_multiplier" numeric(12, 6) DEFAULT '1' NOT NULL,
	"allowed_models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "user_pool_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"pool_group_id" uuid NOT NULL,
	"account_vault_id" uuid,
	"upstream_account_id" bigint NOT NULL,
	"platform" text NOT NULL,
	"account_type" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"status" text DEFAULT 'active' NOT NULL,
	"schedulable" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'import' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_pool_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"connection_id" text DEFAULT 'sub2api' NOT NULL,
	"upstream_user_id" bigint NOT NULL,
	"upstream_group_id" bigint NOT NULL,
	"upstream_api_key_id" bigint NOT NULL,
	"encrypted_upstream_api_key" text NOT NULL,
	"encryption_key_version" text NOT NULL,
	"internal_name" text NOT NULL,
	"display_name" text NOT NULL,
	"status" "user_pool_status" DEFAULT 'provisioning' NOT NULL,
	"max_accounts" integer,
	"last_reconciled_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"available_balance" numeric(20, 8) DEFAULT '0' NOT NULL,
	"held_balance" numeric(20, 8) DEFAULT '0' NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"request_id" text,
	"type" "wallet_transaction_type" NOT NULL,
	"amount" numeric(20, 8) NOT NULL,
	"balance_before" numeric(20, 8) NOT NULL,
	"balance_after" numeric(20, 8) NOT NULL,
	"idempotency_key" text NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "supply_source" "supply_source" DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "pool_group_id" uuid;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "subscription_id" uuid;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "plan_version_id" uuid;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "billable_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "billed_amount" numeric(20, 8) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "request_logs" ADD COLUMN "pricing_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "service_plans" ADD COLUMN "current_version_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "supply_source" "supply_source" DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "pool_group_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "subscription_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "plan_version_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "billable_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_rollups" ADD COLUMN "billed_amount" numeric(20, 8) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD COLUMN "plan_version_id" uuid;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD COLUMN "entitlement_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "service_plan_versions" ADD CONSTRAINT "service_plan_versions_plan_id_service_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."service_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_plan_versions" ADD CONSTRAINT "service_plan_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_pool_accounts" ADD CONSTRAINT "user_pool_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_pool_accounts" ADD CONSTRAINT "user_pool_accounts_pool_group_id_user_pool_groups_id_fk" FOREIGN KEY ("pool_group_id") REFERENCES "public"."user_pool_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_pool_accounts" ADD CONSTRAINT "user_pool_accounts_account_vault_id_account_vault_entries_id_fk" FOREIGN KEY ("account_vault_id") REFERENCES "public"."account_vault_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_pool_accounts" ADD CONSTRAINT "user_pool_accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_pool_groups" ADD CONSTRAINT "user_pool_groups_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_pool_groups" ADD CONSTRAINT "user_pool_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_wallets" ADD CONSTRAINT "user_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_user_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."user_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_plan_versions_plan_version_idx" ON "service_plan_versions" USING btree ("plan_id","version");--> statement-breakpoint
CREATE INDEX "service_plan_versions_plan_idx" ON "service_plan_versions" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_pool_accounts_group_upstream_idx" ON "user_pool_accounts" USING btree ("pool_group_id","upstream_account_id");--> statement-breakpoint
CREATE INDEX "user_pool_accounts_owner_status_idx" ON "user_pool_accounts" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "user_pool_groups_owner_idx" ON "user_pool_groups" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_pool_groups_connection_user_idx" ON "user_pool_groups" USING btree ("connection_id","upstream_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_pool_groups_connection_group_idx" ON "user_pool_groups" USING btree ("connection_id","upstream_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_pool_groups_connection_key_idx" ON "user_pool_groups" USING btree ("connection_id","upstream_api_key_id");--> statement-breakpoint
CREATE INDEX "user_pool_groups_status_idx" ON "user_pool_groups" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "user_wallets_user_idx" ON "user_wallets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transactions_wallet_idempotency_idx" ON "wallet_transactions" USING btree ("wallet_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "wallet_transactions_request_idx" ON "wallet_transactions" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "wallet_transactions_created_idx" ON "wallet_transactions" USING btree ("created_at");
--> statement-breakpoint
INSERT INTO "service_plan_versions" ("plan_id", "version", "billing_mode", "supply_mode", "cycle", "token_limit", "quota_unit", "price", "created_by")
SELECT p."id", 1,
  CASE p."mode" WHEN 'token' THEN 'token_package' WHEN 'cost' THEN 'token_metered' ELSE 'unlimited' END,
  'platform_only', p."cycle", p."token_limit", 'raw_token', p."price", p."created_by"
FROM "service_plans" p
WHERE NOT EXISTS (SELECT 1 FROM "service_plan_versions" v WHERE v."plan_id" = p."id");
--> statement-breakpoint
UPDATE "service_plans" p
SET "current_version_id" = v."id", "updated_at" = now()
FROM "service_plan_versions" v
WHERE v."plan_id" = p."id" AND v."version" = 1 AND p."current_version_id" IS NULL;
--> statement-breakpoint
UPDATE "user_subscriptions" s
SET "plan_version_id" = p."current_version_id",
    "entitlement_snapshot" = jsonb_build_object(
      'planId', p."id", 'planVersionId', p."current_version_id", 'name', p."name",
      'description', p."description", 'billingMode', v."billing_mode", 'supplyMode', v."supply_mode",
      'cycle', v."cycle", 'tokenLimit', v."token_limit", 'quotaUnit', v."quota_unit", 'price', v."price",
      'maxPoolAccounts', v."max_pool_accounts", 'privateUsageBilling', v."private_usage_billing",
      'privateUsageRateMultiplier', v."private_usage_rate_multiplier", 'allowedModels', v."allowed_models", 'settings', v."settings"
    ), "updated_at" = now()
FROM "service_plans" p
JOIN "service_plan_versions" v ON v."id" = p."current_version_id"
WHERE s."plan_id" = p."id" AND (s."plan_version_id" IS NULL OR s."entitlement_snapshot" = '{}'::jsonb);
