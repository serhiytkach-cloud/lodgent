import { createHash, randomBytes } from 'node:crypto';
import {
  type Clock,
  ConflictError,
  canGrantRole,
  ForbiddenError,
  NotFoundError,
  type Role,
  UnprocessableError,
} from '@lodgent/core';
import type { Database } from '@lodgent/db';
import type { CreateInvitationInput } from '@lodgent/shared';
import type { z } from 'zod';
import { assertCan, type OrgContext, type UserContext, userActor } from '../context';

const INVITATION_TTL_MS = 7 * 24 * 3600 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export class MemberService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly webBaseUrl: string,
  ) {}

  async list(ctx: OrgContext) {
    assertCan(ctx, 'members.read');
    const rows = await this.db.tenant(ctx.orgId, (r) => r.members.list());
    return rows.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() }));
  }

  async listInvitations(ctx: OrgContext) {
    assertCan(ctx, 'members.invite');
    const rows = await this.db.tenant(ctx.orgId, (r) => r.invitations.listPending(this.clock.now()));
    return rows.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      expiresAt: i.expiresAt.toISOString(),
      createdAt: i.createdAt.toISOString(),
    }));
  }

  async invite(ctx: OrgContext, input: z.infer<typeof CreateInvitationInput>) {
    assertCan(ctx, 'members.invite');
    if (!canGrantRole(ctx.role, input.role))
      throw new ForbiddenError(`You cannot invite someone as ${input.role}`);
    const token = newToken();
    const now = this.clock.now();
    const invitation = await this.db.tenant(ctx.orgId, async (r) => {
      const members = await r.members.list();
      if (members.some((m) => m.email === input.email)) {
        throw new ConflictError('already_member', `${input.email} is already a member`);
      }
      const org = await r.organization.get();
      const created = await r.invitations.create({
        email: input.email,
        role: input.role,
        tokenHash: hashToken(token),
        invitedByUserId: ctx.userId,
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      });
      await r.outbox.add('email.send', {
        to: input.email,
        template: 'invitation',
        data: {
          organizationName: org?.name ?? 'your team',
          inviterEmail: ctx.email,
          role: input.role,
          link: `${this.webBaseUrl}/invite/${token}`,
        },
      });
      await r.audit.record({
        ...userActor(ctx),
        action: 'invitation.created',
        entityType: 'invitation',
        entityId: created.id,
        changes: { email: input.email, role: input.role },
      });
      return created;
    });
    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
      createdAt: invitation.createdAt.toISOString(),
    };
  }

  async revokeInvitation(ctx: OrgContext, invitationId: string): Promise<void> {
    assertCan(ctx, 'members.invite');
    await this.db.tenant(ctx.orgId, async (r) => {
      const revoked = await r.invitations.revoke(invitationId, this.clock.now());
      if (!revoked) throw new NotFoundError('Invitation');
      await r.audit.record({
        ...userActor(ctx),
        action: 'invitation.revoked',
        entityType: 'invitation',
        entityId: invitationId,
      });
    });
  }

  /** Accepts an invitation for the signed-in user. The invitation must be addressed to their email. */
  async acceptInvitation(ctx: UserContext, token: string): Promise<{ organizationId: string; role: Role }> {
    const now = this.clock.now();
    const invitation = await this.db.system(({ identity }) =>
      identity.findInvitationByTokenHash(hashToken(token)),
    );
    if (!invitation || invitation.revokedAt) throw new NotFoundError('Invitation');
    if (invitation.acceptedAt)
      throw new UnprocessableError('invitation_used', 'This invitation has already been used');
    if (invitation.expiresAt <= now)
      throw new UnprocessableError('invitation_expired', 'This invitation has expired');
    if (invitation.email !== ctx.email.toLowerCase()) {
      throw new ForbiddenError(
        `This invitation was sent to ${invitation.email}. Sign in with that address to accept it.`,
      );
    }
    await this.db.tenant(invitation.organizationId, async (r) => {
      await r.members.add(ctx.userId, invitation.role);
      await r.invitations.markAccepted(invitation.id, ctx.userId, now);
      await r.audit.record({
        actorType: 'user',
        actorUserId: ctx.userId,
        requestId: ctx.requestId ?? null,
        action: 'invitation.accepted',
        entityType: 'invitation',
        entityId: invitation.id,
        changes: { role: invitation.role },
      });
    });
    return { organizationId: invitation.organizationId, role: invitation.role };
  }

  async changeRole(ctx: OrgContext, userId: string, role: Role): Promise<void> {
    assertCan(ctx, 'members.manage');
    await this.db.tenant(ctx.orgId, async (r) => {
      const member = await r.members.get(userId);
      if (!member) throw new NotFoundError('Member');
      if (member.role === role) return;
      if (member.role === 'owner' && (await r.members.countOwners()) <= 1) {
        throw new UnprocessableError('last_owner', 'An organization needs at least one owner');
      }
      await r.members.setRole(userId, role);
      await r.audit.record({
        ...userActor(ctx),
        action: 'member.role_changed',
        entityType: 'member',
        entityId: userId,
        changes: { role: { from: member.role, to: role } },
      });
    });
  }

  /** Removes a member. Owners can remove anyone; everyone can remove themselves (leave). */
  async remove(ctx: OrgContext, userId: string): Promise<void> {
    if (userId !== ctx.userId) assertCan(ctx, 'members.manage');
    await this.db.tenant(ctx.orgId, async (r) => {
      const member = await r.members.get(userId);
      if (!member) throw new NotFoundError('Member');
      if (member.role === 'owner' && (await r.members.countOwners()) <= 1) {
        throw new UnprocessableError('last_owner', 'An organization needs at least one owner');
      }
      await r.members.remove(userId);
      await r.audit.record({
        ...userActor(ctx),
        action: userId === ctx.userId ? 'member.left' : 'member.removed',
        entityType: 'member',
        entityId: userId,
      });
    });
  }
}
