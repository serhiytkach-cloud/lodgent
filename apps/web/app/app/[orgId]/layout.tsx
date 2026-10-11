import type { ReactNode } from 'react';
import { Logo } from '@/components/logo';
import { api } from '@/lib/api';
import type { Me, Organization } from '@/lib/types';
import { OrgSwitcher, SideNav } from './nav';

export default async function OrgLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const [me, org] = await Promise.all([api<Me>('/v1/me'), api<Organization>(`/v1/orgs/${orgId}`)]);
  return (
    <div className="flex min-h-screen bg-muted/40">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-card md:flex">
        <div className="px-5 py-5">
          <Logo />
        </div>
        <div className="px-3">
          <OrgSwitcher current={org} memberships={me.memberships} />
        </div>
        <SideNav orgId={orgId} role={org.role} />
        <div className="mt-auto border-t p-4 text-xs text-muted-foreground">
          <p className="truncate" title={me.user.email}>
            {me.user.email}
          </p>
          <p className="capitalize">{org.role}</p>
          <form action="/auth/logout" method="post" className="mt-2">
            <button type="submit" className="text-primary hover:underline">
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b bg-card px-4 py-3 md:hidden">
          <Logo />
          <span className="text-sm text-muted-foreground">{org.name}</span>
        </header>
        <div className="border-b bg-card md:hidden">
          <SideNav orgId={orgId} role={org.role} compact />
        </div>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 md:px-8">{children}</main>
      </div>
    </div>
  );
}
