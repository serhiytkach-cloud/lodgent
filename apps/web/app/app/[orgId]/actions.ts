'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { type ActionState, actionError, api } from '@/lib/api';
import type { Property } from '@/lib/types';

function str(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  if (value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

function num(formData: FormData, key: string): number | null {
  const value = str(formData, key);
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function updateOrganization(
  orgId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await api(`/v1/orgs/${orgId}`, {
      method: 'PATCH',
      body: { name: str(formData, 'name') ?? undefined, billingEmail: str(formData, 'billingEmail') },
    });
  } catch (error) {
    return actionError(error);
  }
  revalidatePath(`/app/${orgId}`, 'layout');
  return { ok: true, message: 'Saved' };
}

export async function inviteMember(
  orgId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const email = str(formData, 'email');
  try {
    await api(`/v1/orgs/${orgId}/invitations`, {
      method: 'POST',
      body: { email, role: str(formData, 'role') ?? 'viewer' },
    });
  } catch (error) {
    return actionError(error);
  }
  revalidatePath(`/app/${orgId}/team`);
  return { ok: true, message: `Invitation sent to ${email}` };
}

export async function revokeInvitation(orgId: string, invitationId: string): Promise<void> {
  await api(`/v1/orgs/${orgId}/invitations/${invitationId}`, { method: 'DELETE' });
  revalidatePath(`/app/${orgId}/team`);
}

export async function changeRole(orgId: string, userId: string, formData: FormData): Promise<void> {
  await api(`/v1/orgs/${orgId}/members/${userId}`, {
    method: 'PATCH',
    body: { role: str(formData, 'role') },
  });
  revalidatePath(`/app/${orgId}/team`);
}

export async function removeMember(orgId: string, userId: string): Promise<void> {
  await api(`/v1/orgs/${orgId}/members/${userId}`, { method: 'DELETE' });
  revalidatePath(`/app/${orgId}/team`);
}

export async function createProperty(
  orgId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let property: Property;
  try {
    property = await api<Property>(`/v1/orgs/${orgId}/properties`, {
      method: 'POST',
      body: {
        name: str(formData, 'name'),
        city: str(formData, 'city'),
        countryCode: str(formData, 'countryCode')?.toUpperCase() ?? null,
        websiteUrl: str(formData, 'websiteUrl'),
        timeZone: str(formData, 'timeZone') ?? 'UTC',
        currency: str(formData, 'currency')?.toUpperCase() ?? 'EUR',
      },
    });
  } catch (error) {
    return actionError(error);
  }
  redirect(`/app/${orgId}/properties/${property.id}`);
}

export async function updateProperty(
  orgId: string,
  propertyId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    await api(`/v1/orgs/${orgId}/properties/${propertyId}`, {
      method: 'PATCH',
      body: {
        name: str(formData, 'name') ?? undefined,
        description: str(formData, 'description'),
        websiteUrl: str(formData, 'websiteUrl'),
        email: str(formData, 'email'),
        phone: str(formData, 'phone'),
        addressLine1: str(formData, 'addressLine1'),
        addressLine2: str(formData, 'addressLine2'),
        city: str(formData, 'city'),
        postalCode: str(formData, 'postalCode'),
        region: str(formData, 'region'),
        countryCode: str(formData, 'countryCode')?.toUpperCase() ?? null,
        latitude: num(formData, 'latitude'),
        longitude: num(formData, 'longitude'),
        timeZone: str(formData, 'timeZone') ?? undefined,
        currency: str(formData, 'currency')?.toUpperCase() ?? undefined,
        checkInTime: str(formData, 'checkInTime'),
        checkOutTime: str(formData, 'checkOutTime'),
        brandColor: str(formData, 'brandColor'),
        logoUrl: str(formData, 'logoUrl'),
      },
    });
  } catch (error) {
    return actionError(error);
  }
  revalidatePath(`/app/${orgId}/properties/${propertyId}`, 'layout');
  return { ok: true, message: 'Saved' };
}
