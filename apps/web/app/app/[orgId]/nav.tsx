'use client';

import {
  BarChart3,
  BedDouble,
  Building2,
  Eye,
  History,
  LayoutDashboard,
  Settings,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { Me, Organization } from '@/lib/types';
import { cn } from '@/lib/utils';

const ITEMS = [
  { href: '', label: 'Overview', icon: LayoutDashboard, exact: true },
  { href: '/properties', label: 'Properties', icon: Building2 },
  { href: '/visibility', label: 'AI visibility', icon: Eye },
  { href: '/bookings', label: 'Bookings & fees', icon: BedDouble },
  { href: '/funnel', label: 'Agent funnel', icon: BarChart3 },
  { href: '/team', label: 'Team', icon: Users },
  { href: '/settings', label: 'Settings', icon: Settings },
  { href: '/audit', label: 'Audit log', icon: History, roles: ['owner', 'admin'] },
] as const;

export function SideNav({
  orgId,
  role,
  compact = false,
}: {
  orgId: string;
  role: Organization['role'];
  compact?: boolean;
}) {
  const pathname = usePathname();
  const base = `/app/${orgId}`;
  return (
    <nav className={cn(compact ? 'flex gap-1 overflow-x-auto px-2 py-2' : 'mt-4 grid gap-0.5 px-3')}>
      {ITEMS.filter((item) => !('roles' in item) || (item.roles as readonly string[]).includes(role)).map(
        (item) => {
          const href = `${base}${item.href}`;
          const active = 'exact' in item && item.exact ? pathname === href : pathname.startsWith(href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={href}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm whitespace-nowrap transition-colors',
                active
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="size-4" />
              {item.label}
            </Link>
          );
        },
      )}
    </nav>
  );
}

export function OrgSwitcher({
  current,
  memberships,
}: {
  current: Organization;
  memberships: Me['memberships'];
}) {
  const router = useRouter();
  if (memberships.length <= 1) {
    return <div className="rounded-md border px-2.5 py-2 text-sm font-medium">{current.name}</div>;
  }
  return (
    <select
      aria-label="Organization"
      className="w-full rounded-md border bg-card px-2.5 py-2 text-sm font-medium"
      value={current.id}
      onChange={(e) => router.push(`/app/${e.target.value}`)}
    >
      {memberships.map((m) => (
        <option key={m.organizationId} value={m.organizationId}>
          {m.organizationName}
        </option>
      ))}
    </select>
  );
}
