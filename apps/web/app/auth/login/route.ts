import { randomBytes } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { authorizeUrl, pkcePair, safeNext } from '@/lib/cognito';
import { webEnv } from '@/lib/env';

/** Starts the Cognito managed-login flow (authorization code + PKCE). */
export async function GET(request: NextRequest) {
  const env = webEnv();
  const next = safeNext(request.nextUrl.searchParams.get('next'));
  if (env.authProvider !== 'cognito') {
    return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(next)}`, env.webBaseUrl));
  }
  const state = randomBytes(16).toString('base64url');
  const { verifier, challenge } = pkcePair();
  const response = NextResponse.redirect(authorizeUrl(state, challenge));
  response.cookies.set('lodgent_oauth', JSON.stringify({ state, verifier, next }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProduction,
    path: '/auth',
    maxAge: 600,
  });
  return response;
}
