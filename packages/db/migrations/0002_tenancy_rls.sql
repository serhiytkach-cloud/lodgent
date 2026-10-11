-- Row-level security for the tenancy tables.
SELECT app_enable_tenant_rls('memberships');
--> statement-breakpoint
SELECT app_enable_tenant_rls('invitations');
--> statement-breakpoint
SELECT app_enable_tenant_rls('properties');
--> statement-breakpoint
SELECT app_enable_tenant_rls('audit_logs');
--> statement-breakpoint
SELECT app_enable_tenant_rls('outbox');
--> statement-breakpoint
-- organizations: a tenant sees and updates only its own row.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON organizations FOR ALL TO lodgent_tenant
  USING (id = app_current_org()) WITH CHECK (id = app_current_org());
--> statement-breakpoint
CREATE POLICY system_access ON organizations FOR ALL TO lodgent_system USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, UPDATE ON organizations TO lodgent_tenant;
--> statement-breakpoint
-- users: a tenant can read the users who are members of its organization, nothing else.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_members ON users FOR SELECT TO lodgent_tenant
  USING (EXISTS (
    SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.organization_id = app_current_org()
  ));
--> statement-breakpoint
CREATE POLICY system_access ON users FOR ALL TO lodgent_system USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT (id, email, name) ON users TO lodgent_tenant;
--> statement-breakpoint
-- jobs are system-only; tenants never touch the queue directly (they write to the outbox).
REVOKE ALL ON jobs FROM lodgent_tenant;
