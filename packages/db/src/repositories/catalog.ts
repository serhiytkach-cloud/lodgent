import { and, eq, or } from 'drizzle-orm';
import type { Tx } from '../client';
import { properties } from '../schema';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The public, cross-tenant catalog of published hotels. Only ever exposes properties with
 * status = published; tenant data is then read through a tenant context for the owning org.
 */
export function catalogRepo(tx: Tx) {
  return {
    async publishedPropertyOwner(
      idOrSlug: string,
    ): Promise<{ organizationId: string; propertyId: string } | undefined> {
      const match = UUID_RE.test(idOrSlug)
        ? or(eq(properties.id, idOrSlug), eq(properties.slug, idOrSlug))
        : eq(properties.slug, idOrSlug.toLowerCase());
      const [row] = await tx
        .select({ organizationId: properties.organizationId, propertyId: properties.id })
        .from(properties)
        .where(and(match, eq(properties.status, 'published')));
      return row;
    },
  };
}
