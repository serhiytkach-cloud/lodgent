CREATE TYPE "public"."booking_status" AS ENUM('pending_payment', 'reserving', 'confirmed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."fee_collection" AS ENUM('application_fee', 'invoice');--> statement-breakpoint
CREATE TYPE "public"."fee_status" AS ENUM('collected', 'pending', 'invoiced', 'void');--> statement-breakpoint
CREATE TYPE "public"."payment_account_status" AS ENUM('onboarding', 'active', 'restricted');--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"hold_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"status" "booking_status" DEFAULT 'pending_payment' NOT NULL,
	"status_reason" text,
	"payment_mode" "payment_mode" NOT NULL,
	"currency" text NOT NULL,
	"total_amount" bigint NOT NULL,
	"due_now_amount" bigint NOT NULL,
	"fee_bps" integer NOT NULL,
	"fee_amount" bigint NOT NULL,
	"arrival" date NOT NULL,
	"departure" date NOT NULL,
	"adults" integer NOT NULL,
	"children_ages" integer[] DEFAULT '{}'::int[] NOT NULL,
	"room_type_id" uuid NOT NULL,
	"rate_plan_id" uuid NOT NULL,
	"agent_client_id" uuid,
	"channel" "agent_channel" NOT NULL,
	"guest_first_name" text,
	"guest_last_name" text,
	"guest_email" text,
	"guest_phone" text,
	"special_requests" text,
	"terms_accepted_at" timestamp with time zone,
	"pii_redacted_at" timestamp with time zone,
	"payment_account_id" text NOT NULL,
	"payment_intent_id" text,
	"setup_intent_id" text,
	"payment_status" text DEFAULT 'none' NOT NULL,
	"pms_booking_id" text,
	"pms_reservation_id" text,
	"confirmation_number" text,
	"pms_status" text,
	"folio_payment_recorded_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_hold_id_unique" UNIQUE("hold_id"),
	CONSTRAINT "bookings_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "fee_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"collection" "fee_collection" NOT NULL,
	"status" "fee_status" NOT NULL,
	"fee_bps" integer NOT NULL,
	"booking_total_amount" bigint NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"invoice_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_ledger_booking_id_unique" UNIQUE("booking_id")
);
--> statement-breakpoint
CREATE TABLE "payment_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"account_id" text NOT NULL,
	"status" "payment_account_status" DEFAULT 'onboarding' NOT NULL,
	"charges_enabled" boolean DEFAULT false NOT NULL,
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"details_submitted" boolean DEFAULT false NOT NULL,
	"country" text,
	"default_currency" text,
	"requirements_due" text[] DEFAULT '{}'::text[] NOT NULL,
	"connected_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_accounts_organization_id_unique" UNIQUE("organization_id"),
	CONSTRAINT "payment_accounts_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_hold_id_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."holds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_agent_client_id_agent_clients_id_fk" FOREIGN KEY ("agent_client_id") REFERENCES "public"."agent_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_ledger" ADD CONSTRAINT "fee_ledger_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_ledger" ADD CONSTRAINT "fee_ledger_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_ledger" ADD CONSTRAINT "fee_ledger_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_property_idx" ON "bookings" USING btree ("property_id","created_at");--> statement-breakpoint
CREATE INDEX "bookings_status_idx" ON "bookings" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "bookings_pms_reservation_idx" ON "bookings" USING btree ("pms_reservation_id");--> statement-breakpoint
CREATE INDEX "fee_ledger_org_idx" ON "fee_ledger" USING btree ("organization_id","occurred_at");