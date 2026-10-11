import type { Container } from '@lodgent/application';
import {
  CreatePropertyInput,
  DisplayMoney,
  OfferQueryInput,
  PropertyDto,
  UpdatePropertyInput,
} from '@lodgent/shared';
import { z } from 'zod';
import { ParamsWithOrg, type Router } from '../http/router';

export const PropertyParams = ParamsWithOrg.extend({ propertyId: z.uuid() });

export function registerPropertyRoutes(router: Router, container: Container): void {
  const { properties } = container.services;
  const base = { tags: ['properties'], audience: 'dashboard', auth: 'org' } as const;

  router.add({
    ...base,
    method: 'GET',
    path: '/v1/orgs/:orgId/properties',
    operationId: 'listProperties',
    summary: 'List the organization’s properties',
    permission: 'property.read',
    params: ParamsWithOrg,
    response: z.object({ properties: z.array(PropertyDto) }),
    handler: async ({ org }) => ({ properties: await properties.list(org) }),
  });

  router.add({
    ...base,
    method: 'POST',
    path: '/v1/orgs/:orgId/properties',
    operationId: 'createProperty',
    summary: 'Create a property manually (properties are normally imported from the PMS)',
    permission: 'property.write',
    params: ParamsWithOrg,
    body: CreatePropertyInput,
    response: PropertyDto,
    status: 201,
    handler: async ({ org, body }) => properties.create(org, body),
  });

  router.add({
    ...base,
    method: 'GET',
    path: '/v1/orgs/:orgId/properties/:propertyId',
    operationId: 'getProperty',
    summary: 'Get a property',
    permission: 'property.read',
    params: PropertyParams,
    response: PropertyDto,
    handler: async ({ org, params }) => properties.get(org, params.propertyId),
  });

  router.add({
    ...base,
    method: 'PATCH',
    path: '/v1/orgs/:orgId/properties/:propertyId',
    operationId: 'updateProperty',
    summary: 'Update a property',
    permission: 'property.write',
    params: PropertyParams,
    body: UpdatePropertyInput,
    response: PropertyDto,
    handler: async ({ org, params, body }) => properties.update(org, params.propertyId, body),
  });

  const { inventory, offers } = container.services;
  const RatePlanDto = z.object({
    id: z.uuid(),
    name: z.string(),
    code: z.string().nullable(),
    description: z.string().nullable(),
    minGuarantee: z.enum(['none', 'credit_card', 'prepayment', 'company']),
    paymentMode: z.enum(['prepaid', 'pay_at_hotel']).nullable(),
    isBookable: z.boolean(),
    channelCodes: z.array(z.string()),
    exposedToAgents: z.boolean(),
    includes: z.array(z.string()),
    cancellationPolicy: z.object({ title: z.string(), description: z.string().nullable() }).nullable(),
  });

  router.add({
    ...base,
    method: 'GET',
    path: '/v1/orgs/:orgId/properties/:propertyId/rooms',
    operationId: 'listRoomsAndRates',
    summary: 'Room types, rate plans and policies imported from the PMS',
    permission: 'property.read',
    params: PropertyParams,
    response: z.object({
      roomTypes: z.array(
        z.object({
          id: z.uuid(),
          name: z.string(),
          description: z.string().nullable(),
          maxOccupancy: z.number().int().nullable(),
          unitCount: z.number().int().nullable(),
          pmsId: z.string().nullable(),
          ratePlans: z.array(RatePlanDto),
        }),
      ),
      policies: z.array(
        z.object({
          id: z.uuid(),
          kind: z.string(),
          source: z.enum(['pms', 'hotel']),
          title: z.string(),
          description: z.string().nullable(),
        }),
      ),
    }),
    handler: async ({ org, params }) => inventory.rooms(org, params.propertyId),
  });

  router.add({
    ...base,
    method: 'PATCH',
    path: '/v1/orgs/:orgId/properties/:propertyId/rate-plans/:ratePlanId',
    operationId: 'updateRatePlan',
    summary: 'Choose whether AI agents may sell a rate plan',
    permission: 'property.publish',
    params: PropertyParams.extend({ ratePlanId: z.uuid() }),
    body: z.object({ exposedToAgents: z.boolean() }),
    response: z.object({ id: z.uuid(), exposedToAgents: z.boolean() }),
    handler: async ({ org, params, body }) =>
      inventory.setRatePlanExposure(org, params.propertyId, params.ratePlanId, body.exposedToAgents),
  });

  router.add({
    ...base,
    method: 'GET',
    path: '/v1/orgs/:orgId/properties/:propertyId/offer-preview',
    operationId: 'previewOffers',
    summary: 'Live offers from the PMS for a stay, including rate plans not exposed to agents',
    permission: 'property.read',
    rateLimitPerMinute: 30,
    params: PropertyParams,
    query: OfferQueryInput,
    response: z.object({
      offers: z.array(
        z.object({
          roomTypeName: z.string(),
          ratePlanName: z.string(),
          ratePlanId: z.uuid().nullable(),
          exposedToAgents: z.boolean(),
          paymentMode: z.enum(['prepaid', 'pay_at_hotel']).nullable(),
          total: DisplayMoney,
          availableUnits: z.number().int(),
          cancellation: z.string(),
        }),
      ),
    }),
    handler: async ({ org, params, query }) => ({
      offers: await offers.preview(org.orgId, { propertyId: params.propertyId, ...query }),
    }),
  });
}
