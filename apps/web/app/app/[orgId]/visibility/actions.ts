'use server';

import { revalidatePath } from 'next/cache';
import { type ActionState, actionError, api } from '@/lib/api';

const base = (orgId: string, propertyId: string) => `/v1/orgs/${orgId}/properties/${propertyId}/visibility`;
const refresh = (orgId: string) => revalidatePath(`/app/${orgId}/visibility`);

export async function runCheck(orgId: string, propertyId: string): Promise<ActionState> {
  try {
    await api(`${base(orgId, propertyId)}/run`, { method: 'POST', redirectOnUnauthorized: false });
    refresh(orgId);
    return { ok: true, message: 'Check started. Results appear here in a few minutes.' };
  } catch (error) {
    return actionError(error);
  }
}

export async function addQuestion(
  orgId: string,
  propertyId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await api(`${base(orgId, propertyId)}/queries`, {
      method: 'POST',
      body: { text: String(formData.get('text') ?? '') },
      redirectOnUnauthorized: false,
    });
    refresh(orgId);
    return { ok: true, message: 'Question added.' };
  } catch (error) {
    return actionError(error);
  }
}

export async function removeQuestion(orgId: string, propertyId: string, queryId: string): Promise<void> {
  await api(`${base(orgId, propertyId)}/queries/${queryId}`, { method: 'DELETE' });
  refresh(orgId);
}

export async function saveBudget(
  orgId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const dollars = Number(String(formData.get('budget') ?? '').replace(',', '.'));
    if (!Number.isFinite(dollars) || dollars < 0) return { error: 'Enter an amount in US dollars.' };
    await api(`/v1/orgs/${orgId}/visibility/settings`, {
      method: 'PUT',
      body: { monthlyCapCents: Math.round(dollars * 100), enabled: formData.get('enabled') === 'on' },
      redirectOnUnauthorized: false,
    });
    refresh(orgId);
    return { ok: true, message: 'Saved.' };
  } catch (error) {
    return actionError(error);
  }
}
