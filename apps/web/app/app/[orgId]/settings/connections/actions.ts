'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api } from '@/lib/api';

export async function connectApaleo(orgId: string): Promise<void> {
  const { url } = await api<{ url: string }>(`/v1/orgs/${orgId}/integrations/apaleo/authorize`, {
    method: 'POST',
  });
  redirect(url);
}

export async function syncApaleo(orgId: string): Promise<void> {
  await api(`/v1/orgs/${orgId}/integrations/apaleo/sync`, { method: 'POST' });
  revalidatePath(`/app/${orgId}/settings/connections`);
}

export async function disconnectApaleo(orgId: string): Promise<void> {
  await api(`/v1/orgs/${orgId}/integrations/apaleo`, { method: 'DELETE' });
  revalidatePath(`/app/${orgId}/settings/connections`);
}

export async function connectStripe(orgId: string): Promise<void> {
  const { url } = await api<{ url: string }>(`/v1/orgs/${orgId}/payments/onboarding`, { method: 'POST' });
  redirect(url);
}

export async function refreshStripe(orgId: string): Promise<void> {
  await api(`/v1/orgs/${orgId}/payments/refresh`, { method: 'POST' });
  revalidatePath(`/app/${orgId}/settings/connections`);
}
