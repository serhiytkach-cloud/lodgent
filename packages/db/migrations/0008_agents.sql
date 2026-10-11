CREATE TYPE "public"."agent_channel" AS ENUM('mcp', 'rest');--> statement-breakpoint
CREATE TYPE "public"."agent_event_kind" AS ENUM('search_impression', 'hotel_view', 'offers_view', 'hold_created');--> statement-breakpoint
CREATE TYPE "public"."hold_status" AS ENUM('active', 'processing', 'confirmed', 'failed', 'expired', 'cancelled');--> statement-breakpoint
CREATE TABLE "agent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"query_id" uuid,
	"agent_client_id" uuid,
	"channel" "agent_channel" NOT NULL,
	"kind" "agent_event_kind" NOT NULL,
	"rank" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_client_id" uuid,
	"channel" "agent_channel" NOT NULL,
	"client_name" text,
	"tool" text NOT NULL,
	"destination" text,
	"check_in" date,
	"check_out" date,
	"adults" integer,
	"children" integer,
	"must_have_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"nice_to_have_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"has_preferences" boolean DEFAULT false NOT NULL,
	"result_count" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"offer_quote_id" uuid,
	"room_type_id" uuid NOT NULL,
	"rate_plan_id" uuid NOT NULL,
	"agent_client_id" uuid,
	"channel" "agent_channel" NOT NULL,
	"client_name" text,
	"arrival" date NOT NULL,
	"departure" date NOT NULL,
	"adults" integer NOT NULL,
	"children_ages" integer[] DEFAULT '{}'::int[] NOT NULL,
	"currency" text NOT NULL,
	"total_amount" bigint NOT NULL,
	"due_now_amount" bigint NOT NULL,
	"payment_mode" "payment_mode" NOT NULL,
	"fee_bps" integer NOT NULL,
	"fee_amount" bigint NOT NULL,
	"offer" jsonb NOT NULL,
	"status" "hold_status" DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_query_id_agent_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."agent_queries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_agent_client_id_agent_clients_id_fk" FOREIGN KEY ("agent_client_id") REFERENCES "public"."agent_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_queries" ADD CONSTRAINT "agent_queries_agent_client_id_agent_clients_id_fk" FOREIGN KEY ("agent_client_id") REFERENCES "public"."agent_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_offer_quote_id_offer_quotes_id_fk" FOREIGN KEY ("offer_quote_id") REFERENCES "public"."offer_quotes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_room_type_id_room_types_id_fk" FOREIGN KEY ("room_type_id") REFERENCES "public"."room_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_rate_plan_id_rate_plans_id_fk" FOREIGN KEY ("rate_plan_id") REFERENCES "public"."rate_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_agent_client_id_agent_clients_id_fk" FOREIGN KEY ("agent_client_id") REFERENCES "public"."agent_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_events_property_idx" ON "agent_events" USING btree ("property_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_queries_created_idx" ON "agent_queries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "holds_property_idx" ON "holds" USING btree ("property_id","created_at");--> statement-breakpoint
CREATE INDEX "holds_active_idx" ON "holds" USING btree ("room_type_id","arrival","departure") WHERE status in ('active', 'processing');--> statement-breakpoint
CREATE INDEX "holds_expiry_idx" ON "holds" USING btree ("expires_at") WHERE status = 'active';