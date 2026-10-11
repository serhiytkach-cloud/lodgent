'use server';

import { revalidatePath } from 'next/cache';
import { type ActionState, actionError, api } from '@/lib/api';

const base = (orgId: string, propertyId: string) => `/v1/orgs/${orgId}/properties/${propertyId}`;
const refresh = (orgId: string, propertyId: string) =>
  revalidatePath(`/app/${orgId}/properties/${propertyId}`, 'layout');

export async function reviewSuggestions(
  orgId: string,
  propertyId: string,
  approve: string[],
  reject: string[],
): Promise<ActionState> {
  try {
    const res = await api<{ approved: number; rejected: number }>(
      `${base(orgId, propertyId)}/profile/review`,
      {
        method: 'POST',
        body: { approve, reject },
        redirectOnUnauthorized: false,
      },
    );
    refresh(orgId, propertyId);
    const parts = [
      res.approved ? `${res.approved} approved` : '',
      res.rejected ? `${res.rejected} rejected` : '',
    ];
    return { ok: true, message: parts.filter(Boolean).join(', ') };
  } catch (error) {
    return actionError(error);
  }
}

export async function setAttribute(
  orgId: string,
  propertyId: string,
  attributeCode: string,
  roomTypeId: string | null,
  value: boolean | number | string | null,
): Promise<ActionState> {
  try {
    await api(`${base(orgId, propertyId)}/profile/attributes`, {
      method: 'PUT',
      body: { attributeCode, roomTypeId, value },
      redirectOnUnauthorized: false,
    });
    refresh(orgId, propertyId);
    return { ok: true };
  } catch (error) {
    return actionError(error);
  }
}

export async function reviewDescription(
  orgId: string,
  propertyId: string,
  suggestionId: string,
  accept: boolean,
): Promise<ActionState> {
  try {
    await api(`${base(orgId, propertyId)}/profile/descriptions/${suggestionId}`, {
      method: 'POST',
      body: { accept },
      redirectOnUnauthorized: false,
    });
    refresh(orgId, propertyId);
    return { ok: true, message: accept ? 'Description updated' : 'Suggestion dismissed' };
  } catch (error) {
    return actionError(error);
  }
}

export async function importWebsite(orgId: string, propertyId: string): Promise<ActionState> {
  try {
    await api(`${base(orgId, propertyId)}/profile/import-website`, {
      method: 'POST',
      redirectOnUnauthorized: false,
    });
    refresh(orgId, propertyId);
    return { ok: true, message: 'Import started. Suggestions appear here in a minute or two.' };
  } catch (error) {
    return actionError(error);
  }
}

export async function setPublished(
  orgId: string,
  propertyId: string,
  publish: boolean,
): Promise<ActionState> {
  try {
    await api(`${base(orgId, propertyId)}/${publish ? 'publish' : 'unpublish'}`, {
      method: 'POST',
      redirectOnUnauthorized: false,
    });
    refresh(orgId, propertyId);
    return {
      ok: true,
      message: publish ? 'Published. AI agents can now find and book this hotel.' : 'Hidden from AI agents.',
    };
  } catch (error) {
    return actionError(error);
  }
}
