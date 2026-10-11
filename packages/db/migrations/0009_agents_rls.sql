-- Row-level security for the agent surface. agent_queries is system-only: it spans hotels and
-- tenants never read it directly (each hotel sees its own agent_events).
SELECT app_enable_tenant_rls('agent_events');
--> statement-breakpoint
SELECT app_enable_tenant_rls('holds');
--> statement-breakpoint
REVOKE ALL ON agent_queries FROM lodgent_tenant;
