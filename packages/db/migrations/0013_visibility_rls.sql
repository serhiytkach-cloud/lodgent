-- Row-level security for the AI visibility monitor.
SELECT app_enable_tenant_rls('visibility_settings');
--> statement-breakpoint
SELECT app_enable_tenant_rls('visibility_queries');
--> statement-breakpoint
SELECT app_enable_tenant_rls('visibility_runs');
--> statement-breakpoint
SELECT app_enable_tenant_rls('visibility_results');
