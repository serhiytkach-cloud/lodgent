import { isIP } from 'node:net';
import pino, { type LoggerOptions } from 'pino';

/**
 * PII-safe logging (docs/privacy.md). Logs must never carry guest PII or credentials:
 *  - known secret and guest fields are redacted by path wherever they appear one level deep;
 *  - request URLs lose tokens embedded in paths and the values of sensitive query parameters;
 *  - client IPs are truncated (IPv4 /24, IPv6 /48), enough for abuse triage, not to identify;
 *  - email addresses are masked anywhere inside serialized errors (provider messages quote them).
 */

/** Pino redact paths. `*` matches one level, so both `{ email }` and `{ guest: { email } }` are covered. */
export const LOG_REDACT_PATHS = [
  // Credentials.
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  '*.password',
  '*.token',
  '*.apiKey',
  '*.secret',
  '*.clientSecret',
  '*.accessToken',
  '*.refreshToken',
  // Guest (and staff) personal data.
  'email',
  '*.email',
  'guest',
  '*.guest',
  'guestFirstName',
  '*.guestFirstName',
  'guestLastName',
  '*.guestLastName',
  'guestEmail',
  '*.guestEmail',
  'guestPhone',
  '*.guestPhone',
  'firstName',
  '*.firstName',
  'lastName',
  '*.lastName',
  'phone',
  '*.phone',
  'specialRequests',
  '*.specialRequests',
  'req.body',
];

export const REDACTED = '[redacted]';

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Replaces email addresses in free text (error messages, provider responses) with `[email]`. */
export function scrubEmails(text: string): string {
  return text.replace(EMAIL_PATTERN, '[email]');
}

/** Path segments that are bearer credentials: signed checkout links, invitations, webhook secrets. */
const TOKEN_IN_PATH = /(\/(?:checkout|invite|webhooks\/apaleo)\/)[^/?#]+/g;
/** Query parameters whose values may be personal data (booking search by surname) or secrets (OAuth). */
const SENSITIVE_QUERY_KEYS = new Set([
  'q',
  'email',
  'phone',
  'name',
  'firstname',
  'lastname',
  'code',
  'state',
  'token',
  'key',
]);

function decodeKey(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' ')).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/** A request URL fit for logs: path tokens and sensitive query values replaced. */
export function redactUrl(url: string): string {
  const queryAt = url.indexOf('?');
  const path = (queryAt === -1 ? url : url.slice(0, queryAt)).replace(TOKEN_IN_PATH, `$1${REDACTED}`);
  if (queryAt === -1) return path;
  const query = url
    .slice(queryAt + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const key = eq === -1 ? pair : pair.slice(0, eq);
      return SENSITIVE_QUERY_KEYS.has(decodeKey(key)) && eq !== -1 ? `${key}=${REDACTED}` : pair;
    })
    .join('&');
  return `${path}?${query}`;
}

/** Truncates a client IP for logs: IPv4 to its /24, IPv6 to its /48. */
export function truncateIp(ip: string | undefined): string | undefined {
  if (!ip) return ip;
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) return v4.replace(/\.\d+$/, '.0');
  if (isIP(ip) === 6) {
    const [head = ''] = ip.split('::');
    const groups = head.split(':').filter(Boolean).slice(0, 3);
    return `${groups.join(':')}::/48`;
  }
  return undefined;
}

function scrubDeep(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return scrubEmails(value);
  if (value === null || typeof value !== 'object' || depth > 6) return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, seen, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) out[key] = scrubDeep(v, seen, depth + 1);
  return out;
}

/** The standard pino error serializer, with email addresses masked in every string it produces. */
export function serializeError(error: unknown): unknown {
  if (!(error instanceof Error)) return scrubDeep(error, new WeakSet(), 0);
  return scrubDeep(pino.stdSerializers.err(error), new WeakSet(), 0);
}

/** The subset of a Fastify request the request serializer reads (no framework dependency here). */
interface LoggableRequest {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  headers?: Record<string, unknown>;
  socket?: { remotePort?: number };
}

/** Fastify's default request serializer, with the URL redacted and the client IP truncated. */
export function serializeRequest(req: LoggableRequest) {
  return {
    method: req.method,
    url: req.url ? redactUrl(req.url) : req.url,
    version: req.headers?.['accept-version'],
    host: req.host,
    remoteAddress: truncateIp(req.ip),
    remotePort: req.socket?.remotePort,
  };
}

/** Logger options shared by the API and the worker (see `createContainer`). */
export const privacyLoggerOptions = {
  redact: { paths: LOG_REDACT_PATHS, censor: REDACTED },
  serializers: { req: serializeRequest, err: serializeError },
} satisfies Pick<LoggerOptions, 'redact' | 'serializers'>;
