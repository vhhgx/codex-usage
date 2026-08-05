CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"tone" text DEFAULT 'info' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"mode" text DEFAULT 'unlimited' NOT NULL,
	"cycle" text DEFAULT 'none' NOT NULL,
	"token_limit" bigint,
	"cost_limit" numeric(20, 8),
	"price" numeric(20, 2) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"assigned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN "error_message_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_plans" ADD CONSTRAINT "service_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_plan_id_service_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."service_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcements_status_published_idx" ON "announcements" USING btree ("status","published_at");--> statement-breakpoint
CREATE INDEX "announcements_expires_idx" ON "announcements" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "service_plans_name_idx" ON "service_plans" USING btree ("name");--> statement-breakpoint
CREATE INDEX "service_plans_status_idx" ON "service_plans" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "user_subscriptions_user_idx" ON "user_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_subscriptions_plan_idx" ON "user_subscriptions" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "user_subscriptions_status_expiry_idx" ON "user_subscriptions" USING btree ("status","expires_at");--> statement-breakpoint
INSERT INTO "service_plans" ("id", "name", "description", "mode", "cycle", "status")
VALUES ('00000000-0000-4000-8000-000000000002', '默认不限量', '未单独分配套餐时使用，不限制 Token 或金额额度', 'unlimited', 'none', 'active')
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
UPDATE "groups"
SET "description" = '管理员统一配置的用户权限、渠道与模型范围', "updated_at" = now()
WHERE "id" = '00000000-0000-4000-8000-000000000001'
  AND "description" = '由系统迁移创建，用于承接现有 Hub Key';--> statement-breakpoint
UPDATE "hub_keys" AS key
SET "group_id" = '00000000-0000-4000-8000-000000000001', "updated_at" = now()
FROM "users" AS account
WHERE key."owner_user_id" = account."id" AND account."role" = 'user';--> statement-breakpoint
DELETE FROM "group_memberships" AS membership
USING "users" AS account
WHERE membership."user_id" = account."id" AND account."role" = 'user';--> statement-breakpoint
INSERT INTO "group_memberships" ("group_id", "user_id", "role")
SELECT '00000000-0000-4000-8000-000000000001', "id", 'member'
FROM "users"
WHERE "role" = 'user'
ON CONFLICT ("group_id", "user_id") DO NOTHING;--> statement-breakpoint
INSERT INTO "user_subscriptions" ("user_id", "plan_id")
SELECT "id", '00000000-0000-4000-8000-000000000002'
FROM "users"
WHERE "role" = 'user'
ON CONFLICT ("user_id") DO NOTHING;
