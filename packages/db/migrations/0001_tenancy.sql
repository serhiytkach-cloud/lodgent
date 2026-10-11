CREATE TYPE "public"."actor_type" AS ENUM('user', 'system');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'admin', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."property_status" AS ENUM('draft', 'published', 'unpublished');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"changes" jsonb,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "membership_role" NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"billing_email" text,
	"stripe_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" "property_status" DEFAULT 'draft' NOT NULL,
	"description" text,
	"website_url" text,
	"email" text,
	"phone" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"postal_code" text,
	"region" text,
	"country_code" text,
	"latitude" double precision,
	"longitude" double precision,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"check_in_time" text,
	"check_out_time" text,
	"fee_bps" integer DEFAULT 200 NOT NULL,
	"brand_color" text,
	"logo_url" text,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pms_connection_id" uuid,
	"pms_property_id" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "properties_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_subject" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_auth_subject_unique" UNIQUE("auth_subject"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_idx" ON "audit_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "invitations_org_idx" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "jobs_ready_idx" ON "jobs" USING btree ("run_at") WHERE "jobs"."completed_at" is null and "jobs"."failed_at" is null;--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("available_at") WHERE "outbox"."dispatched_at" is null;--> statement-breakpoint
CREATE INDEX "properties_org_idx" ON "properties" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "properties_org_pms_idx" ON "properties" USING btree ("organization_id","pms_property_id") WHERE "properties"."pms_property_id" is not null;--> statement-breakpoint
CREATE INDEX "properties_status_idx" ON "properties" USING btree ("status");