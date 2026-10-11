import { BRAND } from '@lodgent/shared';

/**
 * Liveness for the load balancer and container health checks. Public (outside the proxy matcher)
 * and self-contained: it must not call the API, so an API outage does not take the web tier out of
 * the target group too.
 */
export function GET() {
  return Response.json(
    { ok: true, service: `${BRAND.slug}-web` },
    { headers: { 'cache-control': 'no-store' } },
  );
}
