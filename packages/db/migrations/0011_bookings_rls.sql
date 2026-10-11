-- Row-level security for payments and bookings.
SELECT app_enable_tenant_rls('payment_accounts');
--> statement-breakpoint
SELECT app_enable_tenant_rls('bookings');
--> statement-breakpoint
SELECT app_enable_tenant_rls('fee_ledger');
