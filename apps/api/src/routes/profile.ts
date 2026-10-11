import type { Container } from '@lodgent/application';
import {
  HotelProfileDto,
  ProfileDto,
  PublishReadinessDto,
  ReviewInput,
  SetAttributeInput,
} from '@lodgent/shared';
import { z } from 'zod';
import type { Router } from '../http/router';
import { PropertyParams } from './properties';

export function registerProfileRoutes(router: Router, container: Container): void {
  const { profile, websiteImport, catalog } = container.services;
  const base = { tags: ['profile'], audience: 'dashboard', auth: 'org' } as const;

  router.add({
    ...base,
    method: 'GET',
    path: '/v1/orgs/:orgId/properties/:propertyId/profile',
    operationId: 'getProfile',
    summary: 'Attribute profile with suggestions to review, provenance and completeness',
    permission: 'property.read',
    params: PropertyParams,
    response: ProfileDto,
    handler: async ({ org, params }) => profile.get(org, params.propertyId),
  });

  router.add({
    ...base,
    method: 'POST',
    path: '/v1/orgs/:orgId/properties/:propertyId/profile/review',
    operationId: 'reviewProfile',
    summary: 'Approve or reject suggestions in bulk',
    permission: 'property.write',
    params: PropertyParams,
    body: ReviewInput,
    response: z.object({ approved: z.number().int(), rejected: z.number().int() }),
    handler: async ({ org, params, body }) => profile.review(org, params.propertyId, body),
  });

  router.add({
    ...base,
    method: 'PUT',
    path: '/v1/orgs/:orgId/properties/:propertyId/profile/attributes',
    operationId: 'setProfileAttribute',
    summary: 'Set or clear an attribute value (the hotel’s own value always wins)',
    permission: 'property.write',
    params: PropertyParams,
    body: SetAttributeInput,
    response: z.object({ ok: z.boolean() }),
    handler: async ({ org, params, body }) => profile.setValue(org, params.propertyId, body),
  });

  router.add({
    ...base,
    method: 'POST',
    path: '/v1/orgs/:orgId/properties/:propertyId/profile/descriptions/:suggestionId',
    operationId: 'reviewDescription',
    summary: 'Accept or dismiss a suggested description',
    permission: 'property.write',
    params: PropertyParams.extend({ suggestionId: z.uuid() }),
    body: z.object({ accept: z.boolean() }),
    response: z.object({ ok: z.boolean() }),
    handler: async ({ org, params, body }) =>
      profile.reviewDescription(org, params.propertyId, params.suggestionId, body.accept),
  });

  router.add({
    ...base,
    method: 'POST',
    path: '/v1/orgs/:orgId/properties/:propertyId/profile/import-website',
    operationId: 'importWebsite',
    summary: 'Crawl the hotel website and suggest attributes and descriptions',
    permission: 'property.write',
    rateLimitPerMinute: 6,
    params: PropertyParams,
    response: z.object({ crawlId: z.uuid() }),
    status: 202,
    handler: async ({ org, params }) => websiteImport.request(org, params.propertyId),
  });

  router.add({
    ...base,
    method: 'GET',
    path: '/v1/orgs/:orgId/properties/:propertyId/publish',
    operationId: 'getPublishReadiness',
    summary: 'Publishing checklist, schema.org JSON-LD and public profile URL',
    permission: 'property.read',
    params: PropertyParams,
    response: PublishReadinessDto,
    handler: async ({ org, params }) => catalog.readiness(org, params.propertyId),
  });

  router.add({
    ...base,
    method: 'POST',
    path: '/v1/orgs/:orgId/properties/:propertyId/publish',
    operationId: 'publishProperty',
    summary: 'Publish the property to AI agents',
    permission: 'property.publish',
    params: PropertyParams,
    response: PublishReadinessDto,
    handler: async ({ org, params }) => catalog.publish(org, params.propertyId),
  });

  router.add({
    ...base,
    method: 'POST',
    path: '/v1/orgs/:orgId/properties/:propertyId/unpublish',
    operationId: 'unpublishProperty',
    summary: 'Hide the property from AI agents',
    permission: 'property.publish',
    params: PropertyParams,
    response: PublishReadinessDto,
    handler: async ({ org, params }) => catalog.unpublish(org, params.propertyId),
  });

  router.add({
    method: 'GET',
    path: '/v1/public/hotels/:idOrSlug',
    operationId: 'getPublicHotelProfile',
    summary: 'Public profile of a published hotel, with its schema.org JSON-LD',
    tags: ['public'],
    audience: 'checkout',
    auth: 'none',
    rateLimitPerMinute: 120,
    params: z.object({ idOrSlug: z.string().min(1).max(120) }),
    response: z.object({ profile: HotelProfileDto, jsonLd: z.record(z.string(), z.unknown()) }),
    handler: async ({ params }) => catalog.publicProfile(params.idOrSlug),
  });
}
