import { webEnv } from '@/lib/env';
import { getSessionToken } from '@/lib/session';

const FILES = new Set(['bookings.csv', 'fees.csv']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Streams a CSV export from the API with the signed-in user's session (the browser never holds the token). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string; file: string }> },
) {
  const { orgId, file } = await params;
  if (!UUID.test(orgId) || !FILES.has(file)) return new Response('Not found', { status: 404 });
  const token = await getSessionToken();
  if (!token) return Response.redirect(new URL('/login?expired=1', request.url), 303);
  const search = new URL(request.url).search;
  const res = await fetch(`${webEnv().apiUrl}/v1/orgs/${orgId}/exports/${file}${search}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/csv' },
    cache: 'no-store',
  });
  if (!res.ok) {
    return new Response(res.status === 403 ? 'You do not have access to this export.' : 'Export failed.', {
      status: res.status,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(res.body, {
    headers: {
      'content-type': res.headers.get('content-type') ?? 'text/csv; charset=utf-8',
      'content-disposition': res.headers.get('content-disposition') ?? `attachment; filename="${file}"`,
      'cache-control': 'no-store',
    },
  });
}
