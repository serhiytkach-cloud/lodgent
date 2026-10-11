-- Lookups for guest data export/erasure and the retention job. See docs/adr/0015-guest-privacy.md.
CREATE INDEX "bookings_guest_email_idx" ON "bookings" USING btree ("organization_id",lower("guest_email")) WHERE "bookings"."guest_email" is not null;--> statement-breakpoint
CREATE INDEX "bookings_pii_retention_idx" ON "bookings" USING btree ("departure") WHERE "bookings"."pii_redacted_at" is null;