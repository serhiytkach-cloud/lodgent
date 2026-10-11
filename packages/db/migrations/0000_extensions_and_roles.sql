-- Extensions, database roles and row-level-security helpers. See docs/adr/0004-tenancy-and-rls.md.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
-- Two NOLOGIN roles that the application's login role switches into per transaction:
--   lodgent_tenant: subject to tenant_isolation policies (app.org_id must match)
--   lodgent_system: explicit cross-tenant access (public catalog, webhooks, worker scans)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lodgent_tenant') THEN
    CREATE ROLE lodgent_tenant NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lodgent_system') THEN
    CREATE ROLE lodgent_system NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT lodgent_tenant TO CURRENT_USER;
--> statement-breakpoint
GRANT lodgent_system TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO lodgent_tenant, lodgent_system;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lodgent_system;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO lodgent_tenant, lodgent_system;
--> statement-breakpoint
-- The organization of the current tenant transaction, or NULL outside one.
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.org_id', true), '')::uuid
$$;
--> statement-breakpoint
-- Enables RLS on a tenant-owned table (one with organization_id) and installs the standard policies.
CREATE OR REPLACE FUNCTION app_enable_tenant_rls(tbl regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s FOR ALL TO lodgent_tenant '
    'USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())',
    tbl);
  EXECUTE format('DROP POLICY IF EXISTS system_access ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY system_access ON %s FOR ALL TO lodgent_system USING (true) WITH CHECK (true)', tbl);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO lodgent_tenant', tbl);
END
$$;
