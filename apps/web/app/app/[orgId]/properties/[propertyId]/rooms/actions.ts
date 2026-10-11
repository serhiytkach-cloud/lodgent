'use server';

import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';

export async function setRatePlanExposure(
  orgId: string,
  propertyId: string,
  ratePlanId: string,
  exposed: boolean,
): Promise<void> {
  await api(`/v1/orgs/${orgId}/properties/${propertyId}/rate-plans/${ratePlanId}`, {
    method: 'PATCH',
    body: { exposedToAgents: exposed },
  });
  revalidatePath(`/app/${orgId}/properties/${propertyId}/rooms`);
}
