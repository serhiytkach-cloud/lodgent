import { createHash } from 'node:crypto';
import {
  type Clock,
  ConflictError,
  type EmbeddingModel,
  effectiveAssignments,
  hotelJsonLd,
  mapPmsToAttributes,
  NotFoundError,
  UnprocessableError,
} from '@lodgent/core';
import type { Database, PropertyRow, TenantRepos } from '@lodgent/db';
import type { HotelProfileDto } from '@lodgent/shared';
import { attribute, displayValue, isTruthyValue } from '@lodgent/taxonomy';
import { assertCan, type OrgContext, userActor } from '../context';
import { ProfileService, profileCompleteness } from './profile';

export interface LoadedProfile {
  property: PropertyRow;
  completeness: number;
  attributes: {
    code: string;
    label: string;
    category: string;
    value: boolean | number | string;
    display: string;
  }[];
  rooms: {
    id: string;
    name: string;
    description: string | null;
    maxOccupancy: number | null;
    attributes: { code: string; label: string; value: boolean | number | string; display: string }[];
    ratePlans: {
      id: string;
      name: string;
      description: string | null;
      paymentMode: 'prepaid' | 'pay_at_hotel';
      includes: string[];
      cancellationPolicy: string | null;
    }[];
  }[];
  policies: { kind: string; title: string; description: string | null }[];
}

/** Everything agents may see about a property: approved attributes and sellable rate plans only. */
export async function loadProfile(r: TenantRepos, propertyId: string): Promise<LoadedProfile | null> {
  const property = await r.properties.get(propertyId);
  if (!property) return null;
  const assignments = await r.attributes.listForProperty(propertyId);
  const roomTypes = await r.roomTypes.listForProperty(propertyId);
  const ratePlans = await r.ratePlans.listForProperty(propertyId);
  const policies = await r.policies.listForProperty(propertyId);
  const effectiveMap = effectiveAssignments(assignments);
  const effective = [...effectiveMap.values()];
  const policyById = new Map(policies.map((p) => [p.id, p]));
  const label = (code: string) => attribute(code)?.label ?? code;
  const display = (code: string, value: boolean | number | string) => {
    const def = attribute(code);
    return def ? displayValue(def, value) : String(value);
  };
  const sellable = ratePlans.filter((rp) => rp.exposedToAgents && rp.isBookable && rp.paymentMode !== null);
  const usedPolicies = new Set(sellable.map((rp) => rp.cancellationPolicyId).filter(Boolean));
  return {
    property,
    completeness: profileCompleteness(property, roomTypes, ratePlans, effectiveMap).score,
    attributes: effective
      .filter((a) => a.roomTypeId === null)
      .map((a) => ({
        code: a.attributeCode,
        label: label(a.attributeCode),
        category: attribute(a.attributeCode)?.category ?? 'other',
        value: a.value,
        display: display(a.attributeCode, a.value),
      }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label)),
    rooms: roomTypes.map((rt) => ({
      id: rt.id,
      name: rt.name,
      description: rt.description,
      maxOccupancy: rt.maxOccupancy,
      attributes: effective
        .filter((a) => a.roomTypeId === rt.id)
        .map((a) => ({
          code: a.attributeCode,
          label: label(a.attributeCode),
          value: a.value,
          display: display(a.attributeCode, a.value),
        })),
      ratePlans: sellable
        .filter((rp) => rp.roomTypeId === rt.id)
        .map((rp) => ({
          id: rp.id,
          name: rp.name,
          description: rp.description,
          paymentMode: rp.paymentMode!,
          includes: rp.includedServices.map((s) => s.name),
          cancellationPolicy: rp.cancellationPolicyId
            ? (policyById.get(rp.cancellationPolicyId)?.title ?? null)
            : null,
        })),
    })),
    // Cancellation terms only for rates agents can actually sell; other policies (house rules) always.
    policies: policies
      .filter((p) => p.kind !== 'cancellation' || usedPolicies.has(p.id))
      .map((p) => ({ kind: p.kind, title: p.title, description: p.description })),
  };
}

export function profileUrl(webBaseUrl: string, slug: string): string {
  return `${webBaseUrl}/hotels/${slug}`;
}

export function toHotelProfileDto(p: LoadedProfile, webBaseUrl: string): HotelProfileDto {
  return {
    hotelId: p.property.id,
    slug: p.property.slug,
    name: p.property.name,
    description: p.property.description,
    address: {
      line1: p.property.addressLine1,
      city: p.property.city,
      postalCode: p.property.postalCode,
      region: p.property.region,
      countryCode: p.property.countryCode,
    },
    location:
      p.property.latitude !== null && p.property.longitude !== null
        ? { latitude: p.property.latitude, longitude: p.property.longitude }
        : null,
    timeZone: p.property.timeZone,
    currency: p.property.currency,
    checkInTime: p.property.checkInTime,
    checkOutTime: p.property.checkOutTime,
    website: p.property.websiteUrl,
    profileUrl: profileUrl(webBaseUrl, p.property.slug),
    photos: p.property.photos,
    attributes: p.attributes,
    roomTypes: p.rooms.filter((r) => r.ratePlans.length > 0),
    policies: p.policies,
  };
}

export function buildJsonLd(p: LoadedProfile, webBaseUrl: string) {
  const url = profileUrl(webBaseUrl, p.property.slug);
  const schemaAttr = (a: { code: string; label: string; value: boolean | number | string }) => ({
    ...a,
    schemaOrg: attribute(a.code)?.schemaOrg ?? { property: 'amenityFeature' as const },
  });
  return hotelJsonLd({
    profileUrl: url,
    bookingUrl: `${url}#book`,
    name: p.property.name,
    description: p.property.description,
    websiteUrl: p.property.websiteUrl,
    email: p.property.email,
    phone: p.property.phone,
    address: {
      line1: p.property.addressLine1,
      line2: p.property.addressLine2,
      city: p.property.city,
      postalCode: p.property.postalCode,
      region: p.property.region,
      countryCode: p.property.countryCode,
    },
    latitude: p.property.latitude,
    longitude: p.property.longitude,
    checkInTime: p.property.checkInTime,
    checkOutTime: p.property.checkOutTime,
    currency: p.property.currency,
    photos: p.property.photos,
    logoUrl: p.property.logoUrl,
    attributes: p.attributes.map(schemaAttr),
    rooms: p.rooms
      .filter((r) => r.ratePlans.length > 0)
      .map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        maxOccupancy: r.maxOccupancy,
        sizeSqm: (r.attributes.find((a) => a.code === 'room_size_sqm')?.value as number | undefined) ?? null,
        attributes: r.attributes.map(schemaAttr),
        ratePlans: r.ratePlans.map((rp) => ({ name: rp.name, description: rp.description })),
      })),
  });
}

/** Text that represents a property for semantic matching. */
export function embeddingDocuments(
  p: LoadedProfile,
): { scope: string; roomTypeId: string | null; text: string }[] {
  const facts = p.attributes
    .filter((a) => isTruthyValue(a.value))
    .map((a) => (typeof a.value === 'boolean' ? a.label : `${a.label}: ${a.value}`));
  const location = [p.property.city, p.property.region, p.property.countryCode].filter(Boolean).join(', ');
  const docs: { scope: string; roomTypeId: string | null; text: string }[] = [
    {
      scope: 'property',
      roomTypeId: null,
      text: [
        `${p.property.name}, ${location}.`,
        p.property.description ?? '',
        facts.length > 0 ? `Features: ${facts.join(', ')}.` : '',
        `Rooms: ${p.rooms.map((r) => `${r.name}${r.description ? ` (${r.description})` : ''}`).join('; ')}.`,
      ]
        .filter(Boolean)
        .join(' '),
    },
  ];
  for (const room of p.rooms) {
    const roomFacts = room.attributes.filter((a) => isTruthyValue(a.value)).map((a) => a.label);
    docs.push({
      scope: room.id,
      roomTypeId: room.id,
      text: `${room.name} at ${p.property.name}. ${room.description ?? ''} ${roomFacts.join(', ')}`.trim(),
    });
  }
  return docs;
}

export class CatalogService {
  constructor(
    private readonly deps: {
      db: Database;
      clock: Clock;
      embeddings: EmbeddingModel;
      webBaseUrl: string;
    },
  ) {}

  /** Derives attribute suggestions from PMS data (job after each sync). */
  async mapPmsAttributes(orgId: string, propertyId: string) {
    return this.deps.db.tenant(orgId, async (r) => {
      const property = await r.properties.get(propertyId);
      if (!property?.pmsPropertyId) return null;
      const roomTypes = await r.roomTypes.listForProperty(propertyId);
      const ratePlans = await r.ratePlans.listForProperty(propertyId);
      const policies = await r.policies.listForProperty(propertyId);
      const policyTitle = new Map(policies.map((p) => [p.id, p.title]));
      const mapped = mapPmsToAttributes({
        propertyPmsId: property.pmsPropertyId,
        ratePlans: ratePlans.map((rp) => ({
          pmsId: rp.pmsId,
          name: rp.name,
          minGuarantee: rp.minGuarantee,
          includedServices: rp.includedServices,
          cancellationTitle: rp.cancellationPolicyId
            ? (policyTitle.get(rp.cancellationPolicyId) ?? null)
            : null,
        })),
        roomTypes: roomTypes.map((rt) => ({
          id: rt.id,
          pmsId: rt.pmsId,
          name: rt.name,
          description: rt.description,
          maxOccupancy: rt.maxOccupancy,
        })),
      });
      return ProfileService.applySuggestions(
        r,
        propertyId,
        mapped.map((m) => ({
          roomTypeId: m.roomTypeId,
          attributeCode: m.code,
          value: m.value,
          source: 'pms' as const,
          confidence: m.confidence,
          evidence: [m.evidence],
        })),
      );
    });
  }

  /** Recomputes embeddings when the profile text changed (content-hash check avoids API calls). */
  async refreshEmbeddings(orgId: string, propertyId: string): Promise<number> {
    const { db, embeddings } = this.deps;
    const plan = await db.tenant(orgId, async (r) => {
      const profile = await loadProfile(r, propertyId);
      if (!profile) return null;
      const existing = new Map((await r.embeddings.listForProperty(propertyId)).map((e) => [e.scopeKey, e]));
      const docs = embeddingDocuments(profile).map((d) => ({
        ...d,
        hash: createHash('sha256').update(`${embeddings.name}\n${d.text}`).digest('hex'),
      }));
      return { docs, stale: docs.filter((d) => existing.get(d.scope)?.contentHash !== d.hash) };
    });
    if (!plan) return 0;
    if (plan.stale.length > 0) {
      const vectors = await embeddings.embed(
        plan.stale.map((d) => d.text),
        'document',
      );
      await db.tenant(orgId, async (r) => {
        for (const [i, d] of plan.stale.entries()) {
          await r.embeddings.upsert({
            propertyId,
            roomTypeId: d.roomTypeId,
            kind: d.roomTypeId ? 'room' : 'property',
            model: embeddings.name,
            contentHash: d.hash,
            content: d.text,
            embedding: vectors[i]!,
          });
        }
      });
    }
    await db.tenant(orgId, (r) =>
      r.embeddings.deleteOthers(
        propertyId,
        plan.docs.map((d) => d.scope),
      ),
    );
    return plan.stale.length;
  }

  async readiness(ctx: OrgContext, propertyId: string) {
    assertCan(ctx, 'property.read');
    return this.deps.db.tenant(ctx.orgId, async (r) => {
      const profile = await loadProfile(r, propertyId);
      if (!profile) throw new NotFoundError('Property');
      const p = profile.property;
      const sellable = profile.rooms.reduce((n, room) => n + room.ratePlans.length, 0);
      const checks = [
        {
          key: 'pms',
          label: 'Connected to Apaleo',
          ok: !!p.pmsPropertyId,
          required: true,
          message: 'Live availability comes from your PMS.',
        },
        {
          key: 'rate_plans',
          label: 'At least one rate plan sold via agents',
          ok: sellable > 0,
          required: true,
          message: 'Choose rate plans under Rooms & rates.',
        },
        {
          key: 'description',
          label: 'Hotel description',
          ok: (p.description ?? '').trim().length >= 80,
          required: true,
          message: 'Agents need a short description (80+ characters).',
        },
        {
          key: 'attributes',
          label: 'At least 5 approved attributes',
          ok: profile.attributes.length >= 5,
          required: true,
          message: 'Approve suggestions on the Profile tab so agents can match you to searches.',
        },
        {
          key: 'location',
          label: 'Map location',
          ok: p.latitude !== null && p.longitude !== null,
          required: false,
          message: 'Coordinates make “near …” searches work.',
        },
      ];
      return {
        status: p.status,
        canPublish: checks.every((c) => c.ok || !c.required),
        checks,
        completeness: profile.completeness,
        profileUrl: profileUrl(this.deps.webBaseUrl, p.slug),
        jsonLd: buildJsonLd(profile, this.deps.webBaseUrl),
      };
    });
  }

  async publish(ctx: OrgContext, propertyId: string) {
    assertCan(ctx, 'property.publish');
    const readiness = await this.readiness(ctx, propertyId);
    if (!readiness.canPublish) {
      const missing = readiness.checks.filter((c) => c.required && !c.ok).map((c) => c.label);
      throw new UnprocessableError('not_ready', `Not ready to publish: ${missing.join('; ')}`, { missing });
    }
    if (readiness.status === 'published') throw new ConflictError('already_published', 'Already published');
    await this.deps.db.tenant(ctx.orgId, async (r) => {
      await r.properties.update(propertyId, { status: 'published', publishedAt: this.deps.clock.now() });
      await r.outbox.add('job.enqueue', { type: 'profile.embed', payload: { orgId: ctx.orgId, propertyId } });
      await r.audit.record({
        ...userActor(ctx),
        action: 'property.published',
        entityType: 'property',
        entityId: propertyId,
      });
    });
    await this.refreshEmbeddings(ctx.orgId, propertyId);
    return this.readiness(ctx, propertyId);
  }

  async unpublish(ctx: OrgContext, propertyId: string) {
    assertCan(ctx, 'property.publish');
    await this.deps.db.tenant(ctx.orgId, async (r) => {
      const property = await r.properties.get(propertyId);
      if (!property) throw new NotFoundError('Property');
      if (property.status !== 'published') return;
      await r.properties.update(propertyId, { status: 'unpublished' });
      await r.audit.record({
        ...userActor(ctx),
        action: 'property.unpublished',
        entityType: 'property',
        entityId: propertyId,
      });
    });
    return this.readiness(ctx, propertyId);
  }

  /** Public profile of a published hotel by id or slug (agents, public profile page). */
  async publicProfile(
    idOrSlug: string,
  ): Promise<{ profile: HotelProfileDto; jsonLd: Record<string, unknown> }> {
    const { db, webBaseUrl } = this.deps;
    const owner = await db.system(({ catalog }) => catalog.publishedPropertyOwner(idOrSlug));
    if (!owner) throw new NotFoundError('Hotel');
    const loaded = await db.tenant(owner.organizationId, (r) => loadProfile(r, owner.propertyId));
    if (loaded?.property.status !== 'published') throw new NotFoundError('Hotel');
    return {
      profile: toHotelProfileDto(loaded, webBaseUrl),
      jsonLd: buildJsonLd(loaded, webBaseUrl),
    };
  }

  /** Called by the profile service after edits, to keep search embeddings fresh for live hotels. */
  static async afterProfileChange(orgId: string, propertyId: string, r: TenantRepos) {
    const property = await r.properties.get(propertyId);
    if (property?.status === 'published') {
      await r.outbox.add(
        'job.enqueue',
        { type: 'profile.embed', payload: { orgId, propertyId } },
        { dedupeKey: `profile.embed:${propertyId}:${Math.floor(Date.now() / 60_000)}` },
      );
    }
  }
}
