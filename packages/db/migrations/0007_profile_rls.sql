-- Row-level security for the profile tables. attribute_definitions is a global, read-only vocabulary.
SELECT app_enable_tenant_rls('attribute_assignments');
--> statement-breakpoint
SELECT app_enable_tenant_rls('description_suggestions');
--> statement-breakpoint
SELECT app_enable_tenant_rls('embeddings');
--> statement-breakpoint
SELECT app_enable_tenant_rls('website_crawls');
--> statement-breakpoint
SELECT app_enable_tenant_rls('crawled_pages');
--> statement-breakpoint
GRANT SELECT ON attribute_definitions TO lodgent_tenant;
