import type { Container } from '@lodgent/application';
import { AddVisibilityQueryInput, VisibilityDto, VisibilitySettingsInput } from '@lodgent/shared';
import { z } from 'zod';
import type { Router } from '../http/router';
import { PropertyParams } from './properties';

export function registerVisibilityRoutes(router: Router, container: Container): void {
  const { visibility } = container.services;
  const base = { tags: ['visibility'], audience: 'dashboard', auth: 'org' } as const;
  const path = '/v1/orgs/:orgId/properties/:propertyId/visibility';

  router.add({
    ...base,
    method: 'GET',
    path,
    operationId: 'getVisibility',
    summary: 'How AI assistants answer travellers’ questions about this hotel’s area',
    permission: 'visibility.read',
    params: PropertyParams,
    response: VisibilityDto,
    handler: async ({ org, params }) => visibility.view(org, params.propertyId),
  });

  router.add({
    ...base,
    method: 'POST',
    path: `${path}/run`,
    operationId: 'runVisibilityCheck',
    summary: 'Run a visibility check now (at most hourly)',
    permission: 'visibility.manage',
    rateLimitPerMinute: 5,
    params: PropertyParams,
    response: z.object({ runId: z.uuid() }),
    status: 202,
    handler: async ({ org, params }) => visibility.requestRun(org, params.propertyId),
  });

  router.add({
    ...base,
    method: 'POST',
    path: `${path}/queries`,
    operationId: 'addVisibilityQuery',
    summary: 'Track another traveller question',
    permission: 'visibility.manage',
    params: PropertyParams,
    body: AddVisibilityQueryInput,
    response: z.object({ id: z.uuid() }),
    status: 201,
    handler: async ({ org, params, body }) => visibility.addQuery(org, params.propertyId, body.text),
  });

  router.add({
    ...base,
    method: 'DELETE',
    path: `${path}/queries/:queryId`,
    operationId: 'removeVisibilityQuery',
    summary: 'Stop tracking a question',
    permission: 'visibility.manage',
    params: PropertyParams.extend({ queryId: z.uuid() }),
    response: z.object({ ok: z.boolean() }),
    handler: async ({ org, params }) => visibility.removeQuery(org, params.propertyId, params.queryId),
  });

  router.add({
    ...base,
    method: 'PUT',
    path: '/v1/orgs/:orgId/visibility/settings',
    operationId: 'updateVisibilitySettings',
    summary: 'Monthly budget and on/off switch for the visibility monitor',
    permission: 'visibility.manage',
    params: z.object({ orgId: z.uuid() }),
    body: VisibilitySettingsInput,
    response: z.object({ enabled: z.boolean(), monthlyCapCents: z.number().int() }),
    handler: async ({ org, body }) => visibility.updateSettings(org, body),
  });
}
