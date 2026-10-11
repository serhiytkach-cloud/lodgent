import {
  type Clock,
  completeness,
  effectiveAssignments,
  NotFoundError,
  scopeKey,
  ValidationError,
} from '@lodgent/core';
import type {
  AttributeAssignmentRow,
  Database,
  PropertyRow,
  RatePlanRow,
  RoomTypeRow,
  SuggestionInput,
  TenantRepos,
} from '@lodgent/db';
import type { AttributeRowDto, ProfileDto, ReviewInput, SetAttributeInput } from '@lodgent/shared';
import {
  ATTRIBUTES,
  type AttributeDefinition,
  attribute,
  CATEGORIES,
  normalizeValue,
} from '@lodgent/taxonomy';
import type { z } from 'zod';
import { assertCan, type OrgContext, userActor } from '../context';

function row(
  def: AttributeDefinition,
  roomTypeId: string | null,
  assignments: AttributeAssignmentRow[],
  effective: Map<string, AttributeAssignmentRow>,
): AttributeRowDto {
  const eff = effective.get(scopeKey(roomTypeId, def.code));
  return {
    code: def.code,
    label: def.label,
    category: def.category,
    valueType: def.valueType,
    enumValues: def.enumValues,
    unit: def.unit,
    importance: def.importance,
    roomTypeId,
    effective: eff ? { value: eff.value, source: eff.source, assignmentId: eff.id } : null,
    suggestions: assignments
      .filter((a) => a.id !== eff?.id && a.status !== 'rejected')
      .sort((a, b) => b.confidence - a.confidence)
      .map((a) => ({
        assignmentId: a.id,
        value: a.value,
        source: a.source,
        confidence: a.confidence,
        status: a.status,
        evidence: a.evidence,
      })),
  };
}

/** Completeness score and prioritized gaps, from the property and its effective attribute values. */
export function profileCompleteness(
  property: PropertyRow,
  roomTypes: RoomTypeRow[],
  ratePlans: RatePlanRow[],
  effective: Map<string, { roomTypeId: string | null; attributeCode: string }>,
) {
  return completeness({
    description: property.description,
    photos: property.photos.length,
    hasCoordinates: property.latitude !== null && property.longitude !== null,
    hasCheckInOut: !!property.checkInTime && !!property.checkOutTime,
    websiteUrl: property.websiteUrl,
    roomTypes: roomTypes.map((rt) => ({ name: rt.name, description: rt.description })),
    exposedRatePlans: ratePlans.filter((rp) => rp.exposedToAgents).length,
    attributes: ATTRIBUTES.map((a) => ({
      code: a.code,
      label: a.label,
      importance: a.importance,
      appliesTo: a.appliesTo,
    })),
    answeredCodes: new Set(
      [...effective.values()].filter((a) => a.roomTypeId === null).map((a) => a.attributeCode),
    ),
  });
}

/** The hotel's attribute profile: review queue, edits, completeness. */
export class ProfileService {
  constructor(
    private readonly deps: {
      db: Database;
      clock: Clock;
      onProfileChanged?: (orgId: string, propertyId: string, r: TenantRepos) => Promise<void>;
    },
  ) {}

  async get(ctx: OrgContext, propertyId: string): Promise<ProfileDto> {
    assertCan(ctx, 'property.read');
    return this.deps.db.tenant(ctx.orgId, async (r) => {
      const property = await r.properties.get(propertyId);
      if (!property) throw new NotFoundError('Property');
      // Sequential on purpose: one transaction means one connection, which runs one query at a time.
      const assignments = await r.attributes.listForProperty(propertyId);
      const roomTypes = await r.roomTypes.listForProperty(propertyId);
      const ratePlans = await r.ratePlans.listForProperty(propertyId);
      const descriptions = await r.descriptions.listPending(propertyId);
      const crawl = await r.crawls.latest(propertyId);
      const effective = effectiveAssignments(assignments);
      const byScope = new Map<string, AttributeAssignmentRow[]>();
      for (const a of assignments) {
        const key = scopeKey(a.roomTypeId, a.attributeCode);
        byScope.set(key, [...(byScope.get(key) ?? []), a]);
      }

      const categories = CATEGORIES.map((c) => ({
        code: c.code,
        label: c.label,
        attributes: ATTRIBUTES.filter((d) => d.category === c.code && d.appliesTo !== 'room').map((d) =>
          row(d, null, byScope.get(scopeKey(null, d.code)) ?? [], effective),
        ),
      }));
      const rooms = roomTypes.map((rt) => ({
        roomTypeId: rt.id,
        name: rt.name,
        attributes: ATTRIBUTES.filter(
          (d) =>
            d.appliesTo !== 'property' &&
            ((byScope.get(scopeKey(rt.id, d.code)) ?? []).length > 0 ||
              (d.appliesTo === 'room' && d.importance >= 4)),
        ).map((d) => row(d, rt.id, byScope.get(scopeKey(rt.id, d.code)) ?? [], effective)),
      }));

      const score = profileCompleteness(property, roomTypes, ratePlans, effective);
      const roomName = new Map(roomTypes.map((rt) => [rt.id, rt]));
      return {
        propertyId,
        completeness: score,
        pendingSuggestions: assignments.filter((a) => a.status === 'suggested').length,
        categories,
        rooms,
        descriptions: descriptions.map((d) => ({
          id: d.id,
          roomTypeId: d.roomTypeId,
          roomTypeName: d.roomTypeId ? (roomName.get(d.roomTypeId)?.name ?? null) : null,
          text: d.text,
          current: d.roomTypeId ? (roomName.get(d.roomTypeId)?.description ?? null) : property.description,
          source: d.source,
          evidenceUrl: d.evidenceUrl,
        })),
        crawl: crawl
          ? {
              id: crawl.id,
              url: crawl.url,
              status: crawl.status,
              pagesFetched: crawl.pagesFetched,
              model: crawl.extractionModel,
              stats: crawl.stats ?? null,
              error: crawl.error,
              createdAt: crawl.createdAt.toISOString(),
              finishedAt: crawl.finishedAt?.toISOString() ?? null,
            }
          : null,
      };
    });
  }

  /** Bulk approve/reject. Approving one value for an attribute implicitly supersedes older approvals. */
  async review(ctx: OrgContext, propertyId: string, input: z.infer<typeof ReviewInput>) {
    assertCan(ctx, 'property.write');
    const overlap = input.approve.filter((id) => input.reject.includes(id));
    if (overlap.length > 0) throw new ValidationError('The same suggestion cannot be approved and rejected');
    const now = this.deps.clock.now();
    return this.deps.db.tenant(ctx.orgId, async (r) => {
      const property = await r.properties.get(propertyId);
      if (!property) throw new NotFoundError('Property');
      const found = await r.attributes.byIds(propertyId, [...input.approve, ...input.reject]);
      if (found.length !== input.approve.length + input.reject.length) throw new NotFoundError('Suggestion');
      const approved = await r.attributes.setStatus(propertyId, input.approve, 'approved', ctx.userId, now);
      const rejected = await r.attributes.setStatus(propertyId, input.reject, 'rejected', ctx.userId, now);
      await r.audit.record({
        ...userActor(ctx),
        action: 'profile.reviewed',
        entityType: 'property',
        entityId: propertyId,
        changes: {
          approved: approved.map((a) => `${a.scopeKey}:${a.attributeCode}=${JSON.stringify(a.value)}`),
          rejected: rejected.map((a) => `${a.scopeKey}:${a.attributeCode}=${JSON.stringify(a.value)}`),
        },
      });
      await this.deps.onProfileChanged?.(ctx.orgId, propertyId, r);
      return { approved: approved.length, rejected: rejected.length };
    });
  }

  /** The hotel sets (or clears) a value itself. */
  async setValue(ctx: OrgContext, propertyId: string, input: z.infer<typeof SetAttributeInput>) {
    assertCan(ctx, 'property.write');
    const def = attribute(input.attributeCode);
    if (!def) throw new ValidationError(`Unknown attribute ${input.attributeCode}`);
    if (input.roomTypeId && def.appliesTo === 'property')
      throw new ValidationError(`${def.label} applies to the hotel, not rooms`);
    if (!input.roomTypeId && def.appliesTo === 'room')
      throw new ValidationError(`${def.label} applies to room types`);
    const value = input.value === null ? null : normalizeValue(def, input.value);
    if (input.value !== null && value === null) throw new ValidationError(`Invalid value for ${def.label}`);
    const now = this.deps.clock.now();
    return this.deps.db.tenant(ctx.orgId, async (r) => {
      const property = await r.properties.get(propertyId);
      if (!property) throw new NotFoundError('Property');
      if (input.roomTypeId) {
        const rt = await r.roomTypes.get(input.roomTypeId);
        if (!rt || rt.propertyId !== propertyId) throw new NotFoundError('Room type');
      }
      if (value === null) {
        await r.attributes.clearScope(propertyId, input.roomTypeId, def.code, ctx.userId, now);
      } else {
        await r.attributes.setHotelValue(propertyId, input.roomTypeId, def.code, value, ctx.userId, now);
      }
      await r.audit.record({
        ...userActor(ctx),
        action: value === null ? 'profile.attribute_cleared' : 'profile.attribute_set',
        entityType: 'property',
        entityId: propertyId,
        changes: { attribute: def.code, roomTypeId: input.roomTypeId, value },
      });
      await this.deps.onProfileChanged?.(ctx.orgId, propertyId, r);
      return { ok: true };
    });
  }

  async reviewDescription(ctx: OrgContext, propertyId: string, suggestionId: string, accept: boolean) {
    assertCan(ctx, 'property.write');
    return this.deps.db.tenant(ctx.orgId, async (r) => {
      const s = await r.descriptions.get(suggestionId);
      if (!s || s.propertyId !== propertyId) throw new NotFoundError('Description suggestion');
      if (accept) {
        if (s.roomTypeId) await r.roomTypes.update(s.roomTypeId, { description: s.text });
        else await r.properties.update(propertyId, { description: s.text });
      }
      await r.descriptions.setStatus(suggestionId, accept ? 'approved' : 'rejected');
      await r.audit.record({
        ...userActor(ctx),
        action: accept ? 'profile.description_accepted' : 'profile.description_dismissed',
        entityType: s.roomTypeId ? 'room_type' : 'property',
        entityId: s.roomTypeId ?? propertyId,
      });
      if (accept) await this.deps.onProfileChanged?.(ctx.orgId, propertyId, r);
      return { ok: true };
    });
  }

  /** Records machine suggestions (PMS mapping, website import). Returns counts by outcome. */
  static async applySuggestions(r: TenantRepos, propertyId: string, suggestions: SuggestionInput[]) {
    const counts = { created: 0, updated: 0, unchanged: 0 };
    for (const s of suggestions) counts[await r.attributes.upsertSuggestion(propertyId, s)]++;
    return counts;
  }
}
