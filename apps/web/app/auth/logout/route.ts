import { NextResponse } from 'next/server';
import { logoutUrl } from '@/lib/cognito';
import { webEnv } from '@/lib/env';
import { REFRESH_COOKIE, SESSION_COOKIE } from '@/lib/session';

export async function POST() {
  const env = webEnv();
  const target = env.authProvider === 'cognito' ? logoutUrl() : new URL('/login', env.webBaseUrl).toString();
  const response = NextResponse.redirect(target, { status: 303 });
  response.cookies.delete(SESSION_COOKIE);
  response.cookies.delete(REFRESH_COOKIE);
  return response;
}
