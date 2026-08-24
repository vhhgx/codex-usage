CREATE TABLE "user_route_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"ordered_source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "checkin_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "encrypted_checkin_token" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "checkin_user_id" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "last_checkin_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "last_checkin_status" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "last_checkin_message" text;--> statement-breakpoint
ALTER TABLE "user_route_preferences" ADD CONSTRAINT "user_route_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
UPDATE "hub_keys" SET "route_mode" = 'platform_then_private' WHERE "owner_user_id" IS NOT NULL AND "route_mode" = 'platform_only';
