import type { Container } from '@lodgent/application';
import { CreatePropertyInput, PropertyDto, UpdatePropertyInput } from '@lodgent/shared';
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
}
