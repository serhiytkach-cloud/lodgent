import { redirect } from 'next/navigation';
import { api } from '@/lib/api';
import type { Me } from '@/lib/types';

export default async function AppIndex() {
  const me = await api<Me>('/v1/me');
  const first = me.memberships[0];
  redirect(first ? `/app/${first.organizationId}` : '/app/onboarding');
}
