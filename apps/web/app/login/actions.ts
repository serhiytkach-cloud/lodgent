'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { type ActionState, ApiError, api } from '@/lib/api';
import { safeNext } from '@/lib/cognito';
import { webEnv } from '@/lib/env';
import { setSession } from '@/lib/session';

const DevLogin = z.object({
  email: z.email(),
  name: z.string().trim().max(120).optional(),
  next: z.string().optional(),
});

export async function devLogin(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (webEnv().authProvider !== 'dev') return { error: 'Email sign-in is disabled' };
  const parsed = DevLogin.safeParse({
    email: formData.get('email'),
    name: formData.get('name') || undefined,
    next: formData.get('next') || undefined,
  });
  if (!parsed.success)
    return { error: 'Enter a valid email address', fieldErrors: { email: 'Enter a valid email address' } };
  try {
    const { token } = await api<{ token: string }>('/v1/auth/dev/login', {
      method: 'POST',
      token: null,
      body: { email: parsed.data.email, name: parsed.data.name },
    });
    await setSession(token, { maxAgeSeconds: 7 * 24 * 3600 });
  } catch (error) {
    if (error instanceof ApiError) return { error: error.message };
    throw error;
  }
  redirect(safeNext(parsed.data.next));
}
