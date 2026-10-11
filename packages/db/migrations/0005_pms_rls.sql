-- Row-level security for the PMS tables. webhook_events is system-only (no tenant grants).
SELECT app_enable_tenant_rls('pms_connections');
--> statement-breakpoint
SELECT app_enable_tenant_rls('room_types');
--> statement-breakpoint
SELECT app_enable_tenant_rls('rate_plans');
--> statement-breakpoint
SELECT app_enable_tenant_rls('policies');
--> statement-breakpoint
SELECT app_enable_tenant_rls('offer_quotes');
