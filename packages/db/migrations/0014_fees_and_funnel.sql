CREATE TYPE "public"."fee_invoice_status" AS ENUM('draft', 'open', 'paid', 'void', 'uncollectible');--> statement-breakpoint
CREATE TABLE "fee_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"period" text NOT NULL,
	"currency" text NOT NULL,
	"amount" bigint NOT NULL,
	"fee_count" integer NOT NULL,
	"status" "fee_invoice_status" DEFAULT 'draft' NOT NULL,
	"provider_invoice_id" text,
	"number" text,
	"hosted_url" text,
	"pdf_url" text,
	"due_at" timestamp with time zone,
	"issued_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_invoices_provider_invoice_id_unique" UNIQUE("provider_invoice_id")
);
--> statement-breakpoint
ALTER TABLE "fee_ledger" ALTER COLUMN "invoice_id" SET DATA TYPE uuid USING "invoice_id"::uuid;--> statement-breakpoint
ALTER TABLE "agent_events" ADD COLUMN "client_name" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "payment_authorized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fee_invoices" ADD CONSTRAINT "fee_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fee_invoices_period_idx" ON "fee_invoices" USING btree ("organization_id","period","currency");--> statement-breakpoint
ALTER TABLE "fee_ledger" ADD CONSTRAINT "fee_ledger_invoice_id_fee_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."fee_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fee_ledger_invoice_idx" ON "fee_ledger" USING btree ("invoice_id");