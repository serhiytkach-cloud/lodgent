CREATE TYPE "public"."visibility_query_source" AS ENUM('suggested', 'hotel');--> statement-breakpoint
CREATE TYPE "public"."visibility_run_status" AS ENUM('queued', 'running', 'completed', 'capped', 'failed');--> statement-breakpoint
CREATE TABLE "visibility_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"text" text NOT NULL,
	"source" "visibility_query_source" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visibility_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"query_id" uuid,
	"query_text" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"mentioned" boolean DEFAULT false NOT NULL,
	"rank" integer,
	"list_size" integer DEFAULT 0 NOT NULL,
	"competitors" text[] DEFAULT '{}'::text[] NOT NULL,
	"cited_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"own_site_cited" boolean DEFAULT false NOT NULL,
	"profile_cited" boolean DEFAULT false NOT NULL,
	"excerpt" text,
	"raw_answer" text,
	"cost_cents" numeric(10, 2) DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visibility_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" "visibility_run_status" DEFAULT 'queued' NOT NULL,
	"cost_cents" numeric(10, 2) DEFAULT 0 NOT NULL,
	"questions" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visibility_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"monthly_cap_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visibility_settings_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
ALTER TABLE "visibility_queries" ADD CONSTRAINT "visibility_queries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_queries" ADD CONSTRAINT "visibility_queries_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_results" ADD CONSTRAINT "visibility_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_results" ADD CONSTRAINT "visibility_results_run_id_visibility_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."visibility_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_results" ADD CONSTRAINT "visibility_results_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_results" ADD CONSTRAINT "visibility_results_query_id_visibility_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."visibility_queries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_runs" ADD CONSTRAINT "visibility_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_runs" ADD CONSTRAINT "visibility_runs_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_settings" ADD CONSTRAINT "visibility_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visibility_queries_property_idx" ON "visibility_queries" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "visibility_results_run_idx" ON "visibility_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "visibility_results_property_idx" ON "visibility_results" USING btree ("property_id","created_at");--> statement-breakpoint
CREATE INDEX "visibility_runs_property_idx" ON "visibility_runs" USING btree ("property_id","created_at");--> statement-breakpoint
CREATE INDEX "visibility_runs_org_month_idx" ON "visibility_runs" USING btree ("organization_id","created_at");