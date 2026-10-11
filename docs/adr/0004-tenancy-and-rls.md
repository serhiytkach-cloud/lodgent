# 0004. Tenancy: repository filters plus Postgres row-level security

Date: 2026-10-11 · Status: accepted

## Context
Every tenant-owned row carries `organization_id`. The spec asks for isolation in the repository layer and with Postgres RLS, with tests proving cross-tenant access fails. Some paths are legitimately cross-tenant: the public agent catalog, checkout by token, webhooks, sign-in and worker scans.

## Decision
- Migration `0000` creates two `NOLOGIN` roles and grants them to the migrating login role:
  - `lodgent_tenant`: every tenant table has a `tenant_isolation` policy, `organization_id = app_current_org()`, for both `USING` and `WITH CHECK`. `app_current_org()` reads the transaction-local setting `app.org_id`.
  - `lodgent_system`: has a `system_access` policy (`true`) for explicit cross-tenant work.
- `Database.tenant(orgId, fn)` opens a transaction, runs `set_config('app.org_id', orgId, true)` and `set_config('role', 'lodgent_tenant', true)` in one round trip, and hands `fn` repositories bound to `orgId`. Those repositories also filter every query by org (defense in depth).
- `Database.system(fn)` switches to `lodgent_system`. There is no third way to query. A login role used outside both contexts sees nothing on RLS-protected tables, unless it owns them (local superuser, RDS master).
- New tenant tables call `SELECT app_enable_tenant_rls('<table>')` in their migration. A guard test fails if any table with an `organization_id` column lacks RLS or the policy.
- `organizations` (own row only) and `users` (only members of the current org; `id, email, name` columns only) have bespoke tenant policies. `jobs` is system-only.

## Consequences
- Tests (`packages/db/test/rls.test.ts`) show that raw SQL inside a tenant transaction cannot read, insert into, update, delete from, or move rows to another organization.
- The production app should connect as a dedicated non-owner login role so that queries outside a context see nothing. The RDS master is used only for migrations (see `docs/runbooks/database.md`).
- `SET ROLE` is transaction-scoped, so pooled connections never leak a tenant context.
