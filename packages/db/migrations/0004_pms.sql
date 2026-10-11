CREATE TYPE "public"."guarantee_type" AS ENUM('none', 'credit_card', 'prepayment', 'company');--> statement-breakpoint
CREATE TYPE "public"."payment_mode" AS ENUM('prepaid', 'pay_at_hotel');--> statement-breakpoint
CREATE TYPE "public"."pms_connection_status" AS ENUM('active', 'error', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."policy_kind" AS ENUM('cancellation', 'no_show', 'pets', 'parking', 'check_in_out', 'children', 'accessibility', 'other');--> statement-breakpoint
CREATE TYPE "public"."policy_source" AS ENUM('pms', 'hotel');--> statement-breakpoint
CREATE TABLE "offer_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"rate_plan_id" uuid NOT NULL,
	"query_key" text NOT NULL,
	"arrival" date NOT NULL,
	"departure" date NOT NULL,
	"adults" integer NOT NULL,
	"children_ages" integer[] DEFAULT '{}'::int[] NOT NULL,
	"currency" text NOT NULL,
	"total_amount" bigint NOT NULL,
	"payment_mode" "payment_mode" NOT NULL,
	"available_units" integer NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text DEFAULT 'apaleo' NOT NULL,
	"account_code" text NOT NULL,
	"account_name" text,
	"status" "pms_connection_status" DEFAULT 'active' NOT NULL,
	"scopes" text,
	"encrypted_tokens" text NOT NULL,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"webhook_subscription_id" text,
	"last_sync_at" timestamp with time zone,
	"last_sync_status" text,
	"last_sync_error" text,
	"last_sync_stats" jsonb,
	"connected_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"kind" "policy_kind" NOT NULL,
	"source" "policy_source" NOT NULL,
	"pms_id" text,
	"code" text,
	"title" text NOT NULL,
	"description" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"pms_id" text,
	"code" text,
	"name" text NOT NULL,
	"description" text,
	"min_guarantee" "guarantee_type" NOT NULL,
	"payment_mode" "payment_mode",
	"channel_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_bookable" boolean DEFAULT true NOT NULL,
	"exposed_to_agents" boolean DEFAULT false NOT NULL,
	"cancellation_policy_id" uuid,
	"included_services" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"pms_id" text,
	"code" text,
	"name" text NOT NULL,
	"description" text,
	"max_occupancy" integer,
	"unit_count" integer,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pms_snapshot" jsonb,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "pms_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "offer_quotes" ADD CONSTRAINT "offer_quotes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_quotes" ADD CONSTRAINT "offer_quotes_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_quotes" ADD CONSTRAINT "offer_quotes_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_quotes" ADD CONSTRAINT "offer_quotes_rate_plan_id_rate_plans_id_fk" FOREIGN KEY ("rate_plan_id") REFERENCES "public"."rate_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pms_connections" ADD CONSTRAINT "pms_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pms_connections" ADD CONSTRAINT "pms_connections_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_plans" ADD CONSTRAINT "rate_plans_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_types" ADD CONSTRAINT "room_types_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_types" ADD CONSTRAINT "room_types_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offer_quotes_lookup_idx" ON "offer_quotes" USING btree ("property_id","query_key","created_at");--> statement-breakpoint
CREATE INDEX "offer_quotes_expiry_idx" ON "offer_quotes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pms_connections_org_provider_idx" ON "pms_connections" USING btree ("organization_id","provider");--> statement-breakpoint
CREATE INDEX "pms_connections_account_idx" ON "pms_connections" USING btree ("provider","account_code");--> statement-breakpoint
CREATE INDEX "policies_property_idx" ON "policies" USING btree ("property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policies_property_pms_idx" ON "policies" USING btree ("property_id","kind","pms_id") WHERE "policies"."pms_id" is not null;--> statement-breakpoint
CREATE INDEX "rate_plans_property_idx" ON "rate_plans" USING btree ("property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_plans_property_pms_idx" ON "rate_plans" USING btree ("property_id","pms_id") WHERE "rate_plans"."pms_id" is not null;--> statement-breakpoint
CREATE INDEX "room_types_property_idx" ON "room_types" USING btree ("property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_types_property_pms_idx" ON "room_types" USING btree ("property_id","pms_id") WHERE "room_types"."pms_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_idx" ON "webhook_events" USING btree ("provider","event_id");