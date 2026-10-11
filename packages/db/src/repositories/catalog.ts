import { and, cosineDistance, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { attributeAssignments, embeddings, properties, ratePlans, roomTypes } from '../schema';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CatalogProperty {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  description: string | null;
  city: string | null;
  region: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  timeZone: string;
  currency: string;
  photos: number;
  hasCheckInOut: boolean;
  websiteUrl: string | null;
}

/**
 * The public, cross-tenant catalog of published hotels. Only ever exposes properties with
 * status = published and approved attribute values; everything else stays behind tenant contexts.
 */
export function catalogRepo(tx: Tx) {
  return {
    async publishedPropertyOwner(
      idOrSlug: string,
    ): Promise<{ organizationId: string; propertyId: string } | undefined> {
      const match = UUID_RE.test(idOrSlug)
        ? eq(properties.id, idOrSlug)
        : eq(properties.slug, idOrSlug.toLowerCase());
      const [row] = await tx
        .select({ organizationId: properties.organizationId, propertyId: properties.id })
        .from(properties)
        .where(and(match, eq(properties.status, 'published')));
      return row;
    },

    async publishedProperties(): Promise<CatalogProperty[]> {
      const rows = await tx
        .select({
          id: properties.id,
          organizationId: properties.organizationId,
          slug: properties.slug,
          name: properties.name,
          description: properties.description,
          city: properties.city,
          region: properties.region,
          countryCode: properties.countryCode,
          latitude: properties.latitude,
          longitude: properties.longitude,
          timeZone: properties.timeZone,
          currency: properties.currency,
          photos: sql<number>`jsonb_array_length(${properties.photos})`,
          checkInTime: properties.checkInTime,
          checkOutTime: properties.checkOutTime,
          websiteUrl: properties.websiteUrl,
        })
        .from(properties)
        .where(eq(properties.status, 'published'))
        .orderBy(properties.id);
      return rows.map(({ checkInTime, checkOutTime, ...r }) => ({
        ...r,
        photos: Number(r.photos),
        hasCheckInOut: !!checkInTime && !!checkOutTime,
      }));
    },

    /** Approved assignments only; the caller resolves the effective value per scope. */
    async approvedAssignments(propertyIds: string[]) {
      if (propertyIds.length === 0) return [];
      return tx
        .select({
          id: attributeAssignments.id,
          propertyId: attributeAssignments.propertyId,
          roomTypeId: attributeAssignments.roomTypeId,
          attributeCode: attributeAssignments.attributeCode,
          value: attributeAssignments.value,
          source: attributeAssignments.source,
          status: attributeAssignments.status,
          reviewedAt: attributeAssignments.reviewedAt,
          updatedAt: attributeAssignments.updatedAt,
        })
        .from(attributeAssignments)
        .where(
          and(
            inArray(attributeAssignments.propertyId, propertyIds),
            eq(attributeAssignments.status, 'approved'),
          ),
        );
    },

    /** Room types with at least one rate plan agents can sell, with the number of such plans. */
    async sellableRooms(propertyIds: string[]) {
      if (propertyIds.length === 0) return [];
      return tx
        .select({
          id: roomTypes.id,
          propertyId: roomTypes.propertyId,
          name: roomTypes.name,
          description: roomTypes.description,
          maxOccupancy: roomTypes.maxOccupancy,
          sellablePlans: sql<number>`count(${ratePlans.id})::int`,
        })
        .from(roomTypes)
        .innerJoin(ratePlans, eq(ratePlans.roomTypeId, roomTypes.id))
        .where(
          and(
            inArray(roomTypes.propertyId, propertyIds),
            eq(ratePlans.exposedToAgents, true),
            eq(ratePlans.isBookable, true),
            isNotNull(ratePlans.paymentMode),
          ),
        )
        .groupBy(roomTypes.id)
        .orderBy(roomTypes.propertyId, roomTypes.name);
    },

    /** Best cosine similarity of each property's documents (hotel and rooms) to a query vector. */
    async similarity(propertyIds: string[], vector: number[], model: string): Promise<Map<string, number>> {
      if (propertyIds.length === 0) return new Map();
      const similarity = sql<number>`max(1 - (${cosineDistance(embeddings.embedding, vector)}))`;
      const rows = await tx
        .select({ propertyId: embeddings.propertyId, similarity })
        .from(embeddings)
        .where(and(inArray(embeddings.propertyId, propertyIds), eq(embeddings.model, model)))
        .groupBy(embeddings.propertyId);
      return new Map(rows.map((r) => [r.propertyId, Number(r.similarity)]));
    },
  };
}
