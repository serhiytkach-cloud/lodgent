'use server';

import { redirect } from 'next/navigation';
import { type ActionState, actionError, api } from '@/lib/api';
import type { Organization } from '@/lib/types';

export async function createOrganization(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let org: Organization;
  try {
    org = await api<Organization>('/v1/orgs', {
      method: 'POST',
      body: {
        name: String(formData.get('name') ?? ''),
        billingEmail: formData.get('billingEmail') ? String(formData.get('billingEmail')) : undefined,
      },
    });
  } catch (error) {
    return actionError(error);
  }
  redirect(`/app/${org.id}/settings/connections?welcome=1`);
}
