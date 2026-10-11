import { NotFoundError, uniqueSlug } from '@lodgent/core';
import type { Database, OrganizationRow } from '@lodgent/db';
import type { CreateOrganizationInput, OrganizationDto, UpdateOrganizationInput } from '@lodgent/shared';
import type { z } from 'zod';
import { assertCan, diff, type OrgContext, type UserContext, userActor } from '../context';

export class OrganizationService {
  constructor(private readonly db: Database) {}

  async create(ctx: UserContext, input: z.infer<typeof CreateOrganizationInput>): Promise<OrganizationDto> {
    const org = await this.db.system(async ({ identity }) => {
      const slug = await uniqueSlug(input.name, (s) => identity.organizationSlugExists(s));
      return identity.createOrganization(
        { name: input.name, slug, billingEmail: input.billingEmail ?? null },
        ctx.userId,
      );
    });
    await this.db.tenant(org.id, (r) =>
      r.audit.record({
        actorType: 'user',
        actorUserId: ctx.userId,
        requestId: ctx.requestId ?? null,
        action: 'organization.created',
        entityType: 'organization',
        entityId: org.id,
        changes: { name: org.name },
      }),
    );
    return toOrganizationDto(org, 'owner');
  }

  async get(ctx: OrgContext): Promise<OrganizationDto> {
    assertCan(ctx, 'org.read');
    const org = await this.db.tenant(ctx.orgId, (r) => r.organization.get());
    if (!org) throw new NotFoundError('Organization');
    return toOrganizationDto(org, ctx.role);
  }

  async update(ctx: OrgContext, patch: z.infer<typeof UpdateOrganizationInput>): Promise<OrganizationDto> {
    assertCan(ctx, 'org.update');
    const org = await this.db.tenant(ctx.orgId, async (r) => {
      const before = await r.organization.get();
      if (!before) throw new NotFoundError('Organization');
      const updated = await r.organization.update(patch);
      await r.audit.record({
        ...userActor(ctx),
        action: 'organization.updated',
        entityType: 'organization',
        entityId: ctx.orgId,
        changes: diff(before, patch),
      });
      return updated!;
    });
    return toOrganizationDto(org, ctx.role);
  }
}

export function toOrganizationDto(org: OrganizationRow, role: OrgContext['role']): OrganizationDto {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    billingEmail: org.billingEmail,
    role,
    createdAt: org.createdAt.toISOString(),
  };
}
