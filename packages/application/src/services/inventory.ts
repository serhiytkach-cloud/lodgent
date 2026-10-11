import { NotFoundError, UnprocessableError } from '@lodgent/core';
import type { Database } from '@lodgent/db';
import { assertCan, type OrgContext, userActor } from '../context';

/** Room types, rate plans and policies as the hotel sees them, plus the per-rate-plan agent opt-in. */
export class InventoryService {
  constructor(private readonly db: Database) {}

  async rooms(ctx: OrgContext, propertyId: string) {
    assertCan(ctx, 'property.read');
    return this.db.tenant(ctx.orgId, async (r) => {
      const property = await r.properties.get(propertyId);
      if (!property) throw new NotFoundError('Property');
      const [roomTypes, ratePlans, policies] = await Promise.all([
        r.roomTypes.listForProperty(propertyId),
        r.ratePlans.listForProperty(propertyId),
        r.policies.listForProperty(propertyId),
      ]);
      const policyById = new Map(policies.map((p) => [p.id, p]));
      return {
        roomTypes: roomTypes.map((rt) => ({
          id: rt.id,
          name: rt.name,
          description: rt.description,
          maxOccupancy: rt.maxOccupancy,
          unitCount: rt.unitCount,
          pmsId: rt.pmsId,
          ratePlans: ratePlans
            .filter((rp) => rp.roomTypeId === rt.id)
            .map((rp) => {
              const policy = rp.cancellationPolicyId ? policyById.get(rp.cancellationPolicyId) : undefined;
              return {
                id: rp.id,
                name: rp.name,
                code: rp.code,
                description: rp.description,
                minGuarantee: rp.minGuarantee,
                paymentMode: rp.paymentMode,
                isBookable: rp.isBookable,
                channelCodes: rp.channelCodes,
                exposedToAgents: rp.exposedToAgents,
                includes: rp.includedServices.map((s) => s.name),
                cancellationPolicy: policy ? { title: policy.title, description: policy.description } : null,
              };
            }),
        })),
        policies: policies.map((p) => ({
          id: p.id,
          kind: p.kind,
          source: p.source,
          title: p.title,
          description: p.description,
        })),
      };
    });
  }

  async setRatePlanExposure(ctx: OrgContext, propertyId: string, ratePlanId: string, exposed: boolean) {
    assertCan(ctx, 'property.publish');
    return this.db.tenant(ctx.orgId, async (r) => {
      const rp = await r.ratePlans.get(ratePlanId);
      if (!rp || rp.propertyId !== propertyId || rp.archivedAt) throw new NotFoundError('Rate plan');
      if (exposed && rp.paymentMode === null) {
        throw new UnprocessableError(
          'rate_plan_not_sellable',
          'Company rates need a contract and can’t be sold to AI agents.',
        );
      }
      if (exposed && !rp.isBookable) {
        throw new UnprocessableError('rate_plan_not_bookable', 'This rate plan is not bookable in Apaleo.');
      }
      if (rp.exposedToAgents === exposed) return { id: rp.id, exposedToAgents: exposed };
      await r.ratePlans.setExposed(ratePlanId, exposed);
      await r.audit.record({
        ...userActor(ctx),
        action: exposed ? 'rate_plan.exposed' : 'rate_plan.hidden',
        entityType: 'rate_plan',
        entityId: ratePlanId,
        changes: { name: rp.name, exposedToAgents: { from: rp.exposedToAgents, to: exposed } },
      });
      return { id: rp.id, exposedToAgents: exposed };
    });
  }
}
