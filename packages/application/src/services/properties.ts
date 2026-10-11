import { NotFoundError, uniqueSlug } from '@lodgent/core';
import type { Database, PropertyRow } from '@lodgent/db';
import type { CreatePropertyInput, PropertyDto, UpdatePropertyInput } from '@lodgent/shared';
import type { z } from 'zod';
import { assertCan, diff, type OrgContext, userActor } from '../context';

export class PropertyService {
  constructor(
    private readonly db: Database,
    private readonly defaultFeeBps: number,
  ) {}

  async list(ctx: OrgContext): Promise<PropertyDto[]> {
    assertCan(ctx, 'property.read');
    const rows = await this.db.tenant(ctx.orgId, (r) => r.properties.list());
    return rows.map(toPropertyDto);
  }

  async get(ctx: OrgContext, propertyId: string): Promise<PropertyDto> {
    assertCan(ctx, 'property.read');
    const row = await this.db.tenant(ctx.orgId, (r) => r.properties.get(propertyId));
    if (!row) throw new NotFoundError('Property');
    return toPropertyDto(row);
  }

  async create(ctx: OrgContext, input: z.infer<typeof CreatePropertyInput>): Promise<PropertyDto> {
    assertCan(ctx, 'property.write');
    const slug = await this.db.system(({ identity }) =>
      uniqueSlug([input.name, input.city].filter(Boolean).join(' '), (s) => identity.propertySlugExists(s)),
    );
    const row = await this.db.tenant(ctx.orgId, async (r) => {
      const created = await r.properties.create({ ...input, slug, feeBps: this.defaultFeeBps });
      await r.audit.record({
        ...userActor(ctx),
        action: 'property.created',
        entityType: 'property',
        entityId: created.id,
        changes: { name: created.name },
      });
      return created;
    });
    return toPropertyDto(row);
  }

  async update(
    ctx: OrgContext,
    propertyId: string,
    patch: z.infer<typeof UpdatePropertyInput>,
  ): Promise<PropertyDto> {
    assertCan(ctx, 'property.write');
    const row = await this.db.tenant(ctx.orgId, async (r) => {
      const before = await r.properties.get(propertyId);
      if (!before) throw new NotFoundError('Property');
      const updated = await r.properties.update(propertyId, patch);
      const changes = diff(before, patch);
      if (Object.keys(changes).length > 0) {
        await r.audit.record({
          ...userActor(ctx),
          action: 'property.updated',
          entityType: 'property',
          entityId: propertyId,
          changes,
        });
      }
      return updated!;
    });
    return toPropertyDto(row);
  }
}

export function toPropertyDto(row: PropertyRow): PropertyDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    slug: row.slug,
    status: row.status,
    name: row.name,
    description: row.description,
    websiteUrl: row.websiteUrl,
    email: row.email,
    phone: row.phone,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    postalCode: row.postalCode,
    region: row.region,
    countryCode: row.countryCode,
    latitude: row.latitude,
    longitude: row.longitude,
    timeZone: row.timeZone,
    currency: row.currency,
    checkInTime: row.checkInTime,
    checkOutTime: row.checkOutTime,
    brandColor: row.brandColor,
    logoUrl: row.logoUrl,
    photos: row.photos,
    feeBps: row.feeBps,
    pmsPropertyId: row.pmsPropertyId,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
