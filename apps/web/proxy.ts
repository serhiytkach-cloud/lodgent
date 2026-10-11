import { BRAND } from '@lodgent/shared';
import { type NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIE = BRAND.sessionCookie;
const REFRESH_COOKIE = `${BRAND.slug}_refresh`;

function expiresAt(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: number;
    };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Optimistic session check for dashboard pages: sends signed-out visitors to sign-in and refreshes
 * Cognito ID tokens shortly before they expire. The API verifies every token; this is only UX.
 */
export async function proxy(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
  const next = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const toLogin = () =>
    NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(next)}`, request.url));

  const exp = token ? expiresAt(token) : null;
  const expiringSoon = exp !== null && exp - Date.now() < 120_000;

  if ((!token || expiringSoon) && refresh && process.env.AUTH_PROVIDER === 'cognito') {
    try {
      const domain = process.env.COGNITO_DOMAIN ?? '';
      const clientId = process.env.COGNITO_CLIENT_ID ?? '';
      const secret = process.env.COGNITO_CLIENT_SECRET ?? '';
      const res = await fetch(`https://${domain}/oauth2/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...(secret ? { authorization: `Basic ${btoa(`${clientId}:${secret}`)}` } : {}),
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: refresh,
        }).toString(),
      });
      if (res.ok) {
        const tokens = (await res.json()) as { id_token: string; expires_in: number };
        const response = NextResponse.next();
        response.cookies.set(SESSION_COOKIE, tokens.id_token, {
          httpOnly: true,
          sameSite: 'lax',
          secure: process.env.APP_ENV === 'production',
          path: '/',
          maxAge: tokens.expires_in,
        });
        return response;
      }
    } catch {
      // fall through to sign-in
    }
    return toLogin();
  }

  if (!token || (exp !== null && exp < Date.now())) return toLogin();
  return NextResponse.next();
}

export const config = {
  matcher: ['/app/:path*', '/invite/:path*'],
};
