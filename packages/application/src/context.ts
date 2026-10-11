import { can, ForbiddenError, type Permission, type Role } from '@lodgent/core';

/** A signed-in hotel user. */
export interface UserContext {
  userId: string;
  email: string;
  requestId?: string;
}

/** A signed-in hotel user acting inside one organization with a verified membership. */
export interface OrgContext extends UserContext {
  orgId: string;
  role: Role;
}

export function assertCan(ctx: OrgContext, permission: Permission): void {
  if (!can(ctx.role, permission)) throw new ForbiddenError();
}

/** Audit metadata for changes made by a user. */
export function userActor(ctx: OrgContext) {
  return { actorType: 'user' as const, actorUserId: ctx.userId, requestId: ctx.requestId ?? null };
}

export const systemActor = { actorType: 'system' as const, actorUserId: null, requestId: null };

/** Returns only the keys whose values changed, as `{ key: { from, to } }`, for audit logs. */
export function diff<T extends Record<string, unknown>>(
  before: T,
  patch: Partial<T>,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const [key, to] of Object.entries(patch)) {
    if (to === undefined) continue;
    const from = before[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to };
  }
  return changes;
}
