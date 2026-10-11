CREATE TYPE "public"."assignment_status" AS ENUM('suggested', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."attribute_source" AS ENUM('pms', 'website', 'hotel', 'ai_extracted');--> statement-breakpoint
CREATE TYPE "public"."crawl_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."embedding_kind" AS ENUM('property', 'room');--> statement-breakpoint
CREATE TABLE "attribute_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"room_type_id" uuid,
	"scope_key" text NOT NULL,
	"attribute_code" text NOT NULL,
	"value" jsonb NOT NULL,
	"source" "attribute_source" NOT NULL,
	"confidence" real NOT NULL,
	"status" "assignment_status" DEFAULT 'suggested' NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attribute_definitions" (
	"code" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"category" text NOT NULL,
	"applies_to" text NOT NULL,
	"importance" integer NOT NULL,
	"value_type" text NOT NULL,
	"enum_values" text[],
	"deprecated" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawled_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"crawl_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "description_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"room_type_id" uuid,
	"scope_key" text NOT NULL,
	"text" text NOT NULL,
	"source" "attribute_source" NOT NULL,
	"evidence_url" text,
	"status" "assignment_status" DEFAULT 'suggested' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"room_type_id" uuid,
	"kind" "embedding_kind" NOT NULL,
	"scope_key" text NOT NULL,
	"model" text NOT NULL,
	"content_hash" text NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(512) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "website_crawls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"url" text NOT NULL,
	"status" "crawl_status" DEFAULT 'queued' NOT NULL,
	"requested_by_user_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"pages_fetched" integer DEFAULT 0 NOT NULL,
	"extraction_model" text,
	"stats" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attribute_assignments" ADD CONSTRAINT "attribute_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_assignments" ADD CONSTRAINT "attribute_assignments_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_assignments" ADD CONSTRAINT "attribute_assignments_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribute_assignments" ADD CONSTRAINT "attribute_assignments_attribute_code_attribute_definitions_code_fk" FOREIGN KEY ("attribute_code") REFERENCES "public"."attribute_definitions"("code") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "attribute_assignments" ADD CONSTRAINT "attribute_assignments_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD CONSTRAINT "crawled_pages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD CONSTRAINT "crawled_pages_crawl_id_website_crawls_id_fk" FOREIGN KEY ("crawl_id") REFERENCES "public"."website_crawls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "description_suggestions" ADD CONSTRAINT "description_suggestions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "description_suggestions" ADD CONSTRAINT "description_suggestions_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "description_suggestions" ADD CONSTRAINT "description_suggestions_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_crawls" ADD CONSTRAINT "website_crawls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_crawls" ADD CONSTRAINT "website_crawls_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_crawls" ADD CONSTRAINT "website_crawls_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attribute_assignments_unique_idx" ON "attribute_assignments" USING btree ("property_id","scope_key","attribute_code","source");--> statement-breakpoint
CREATE INDEX "attribute_assignments_property_idx" ON "attribute_assignments" USING btree ("property_id","status");--> statement-breakpoint
CREATE INDEX "attribute_assignments_code_idx" ON "attribute_assignments" USING btree ("attribute_code","status");--> statement-breakpoint
CREATE INDEX "crawled_pages_crawl_idx" ON "crawled_pages" USING btree ("crawl_id");--> statement-breakpoint
CREATE UNIQUE INDEX "description_suggestions_unique_idx" ON "description_suggestions" USING btree ("property_id","scope_key","source");--> statement-breakpoint
CREATE UNIQUE INDEX "embeddings_scope_idx" ON "embeddings" USING btree ("property_id","scope_key");--> statement-breakpoint
CREATE INDEX "embeddings_hnsw_idx" ON "embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "website_crawls_property_idx" ON "website_crawls" USING btree ("property_id","created_at");