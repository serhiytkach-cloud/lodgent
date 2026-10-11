import { redirect } from 'next/navigation';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';

export default async function AppIndex({ searchParams }: { searchParams: Promise<{ apaleo?: string }> }) {
  const { apaleo } = await searchParams;
  const me = await api<Me>('/v1/me');
  const first = me.memberships[0];
  if (!first) redirect('/app/onboarding');
  // An OAuth result we couldn't tie to an organization: show it on the first organization's connections page.
  if (apaleo && /^[a-z_]{1,40}$/.test(apaleo)) {
    redirect(`/app/${first.organizationId}/settings/connections?apaleo=${apaleo}`);
  }
  redirect(`/app/${first.organizationId}`);
}
