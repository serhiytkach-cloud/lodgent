export const ROLES = ['owner', 'admin', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

const ALL: readonly Role[] = ROLES;
const MANAGERS: readonly Role[] = ['owner', 'admin'];
const OWNERS: readonly Role[] = ['owner'];

/**
 * What each membership role may do. Owners manage people and money; admins run the hotel profile,
 * connections and distribution; viewers can see everything except billing and guest data tools.
 */
export const PERMISSIONS = {
  'org.read': ALL,
  'org.update': MANAGERS,
  'members.read': ALL,
  'members.invite': MANAGERS,
  'members.manage': OWNERS,
  'property.read': ALL,
  'property.write': MANAGERS,
  'property.publish': MANAGERS,
  'pms.manage': MANAGERS,
  'payments.manage': OWNERS,
  'visibility.read': ALL,
  'visibility.manage': MANAGERS,
  'bookings.read': ALL,
  'billing.read': MANAGERS,
  'audit.read': MANAGERS,
  'guest-data.manage': MANAGERS,
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

const RANK: Record<Role, number> = { owner: 3, admin: 2, viewer: 1 };

/** Whether `actor` may grant `target` (invite or assign). Nobody grants above their own role. */
export function canGrantRole(actor: Role, target: Role): boolean {
  if (!can(actor, 'members.invite')) return false;
  return RANK[target] <= RANK[actor];
}
