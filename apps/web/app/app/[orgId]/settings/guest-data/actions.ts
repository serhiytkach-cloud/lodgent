'use server';

import type { GuestDataEraseDto, GuestDataExportDto } from '@lodgent/shared';
import { revalidatePath } from 'next/cache';
import { type ActionState, actionError, api } from '@/lib/api';

export type ExportState =
  | (NonNullable<ActionState> & {
      /** The export as pretty-printed JSON, downloaded by the browser as a file. */
      file?: { name: string; json: string; bookings: number };
    })
  | null;

export type EraseState = (NonNullable<ActionState> & { result?: GuestDataEraseDto }) | null;

function email(formData: FormData): string {
  return String(formData.get('email') ?? '').trim();
}

/** Data subject access request: everything held about one guest, as a JSON file. */
export async function exportGuestData(
  orgId: string,
  _prev: ExportState,
  formData: FormData,
): Promise<ExportState> {
  try {
    const data = await api<GuestDataExportDto>(`/v1/orgs/${orgId}/guest-data/export`, {
      method: 'POST',
      body: { email: email(formData) },
      redirectOnUnauthorized: false,
    });
    const day = data.generatedAt.slice(0, 10);
    return {
      ok: true,
      message:
        data.bookings.length === 0
          ? 'No bookings match this email. The export lists what we checked.'
          : `Exported ${data.bookings.length} booking${data.bookings.length === 1 ? '' : 's'}.`,
      file: {
        // The pseudonymous reference, not the email, names the file.
        name: `guest-data-${day}-${data.subject.ref.slice(2, 10)}.json`,
        json: JSON.stringify(data, null, 2),
        bookings: data.bookings.length,
      },
    };
  } catch (error) {
    return actionError(error);
  }
}

/** Right to erasure: empties the guest's details on all their bookings in this organization. */
export async function eraseGuestData(
  orgId: string,
  _prev: EraseState,
  formData: FormData,
): Promise<EraseState> {
  let result: GuestDataEraseDto;
  try {
    const reason = String(formData.get('reason') ?? '').trim();
    result = await api<GuestDataEraseDto>(`/v1/orgs/${orgId}/guest-data/erase`, {
      method: 'POST',
      body: { email: email(formData), reason: reason || undefined },
      redirectOnUnauthorized: false,
    });
  } catch (error) {
    return actionError(error);
  }
  revalidatePath(`/app/${orgId}/bookings`, 'layout');
  return {
    ok: true,
    message:
      result.matched === 0
        ? 'No bookings with guest details match this email. Nothing to erase.'
        : `Erased the guest’s details on ${result.erased} booking${result.erased === 1 ? '' : 's'}.`,
    result,
  };
}
