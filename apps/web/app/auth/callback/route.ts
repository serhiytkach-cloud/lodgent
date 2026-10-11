import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { exchangeCode, safeNext } from '@/lib/cognito';
import { webEnv } from '@/lib/env';
import { REFRESH_COOKIE, SESSION_COOKIE } from '@/lib/session';

const OAuthState = z.object({ state: z.string(), verifier: z.string(), next: z.string() });

export async function GET(request: NextRequest) {
  const env = webEnv();
  const fail = (reason: string) => NextResponse.redirect(new URL(`/login?error=${reason}`, env.webBaseUrl));
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const raw = request.cookies.get('lodgent_oauth')?.value;
  if (!code || !state || !raw) return fail('missing_code');

  const parsed = OAuthState.safeParse(JSON.parse(raw));
  if (!parsed.success || parsed.data.state !== state) return fail('state_mismatch');

  try {
    const tokens = await exchangeCode(code, parsed.data.verifier);
    const response = NextResponse.redirect(new URL(safeNext(parsed.data.next), env.webBaseUrl));
    const base = { httpOnly: true, sameSite: 'lax' as const, secure: env.isProduction, path: '/' };
    response.cookies.set(SESSION_COOKIE, tokens.id_token, { ...base, maxAge: tokens.expires_in });
    if (tokens.refresh_token)
      response.cookies.set(REFRESH_COOKIE, tokens.refresh_token, { ...base, maxAge: 30 * 24 * 3600 });
    response.cookies.delete({ name: 'lodgent_oauth', path: '/auth' });
    return response;
  } catch {
    return fail('token_exchange');
  }
}
