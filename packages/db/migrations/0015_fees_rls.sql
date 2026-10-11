-- Row-level security for fee invoices; partner names are readable by hotels (for the agent funnel).
SELECT app_enable_tenant_rls('fee_invoices');
--> statement-breakpoint
GRANT SELECT (id, name) ON agent_clients TO lodgent_tenant;
