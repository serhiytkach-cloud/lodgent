import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { FastifyCorsOptions } from '@fastify/cors';
import ipaddr from 'ipaddr.js';

/**
 * Rate-limit bucket for a client address. IPv4 addresses count individually; IPv6 addresses count
 * per /64, the smallest block a subscriber normally gets, so rotating addresses inside one
 * allocation buys no extra requests. IPv4-mapped IPv6 addresses count as their IPv4 address.
 */
export function clientKey(ip: string): string {
  if (!ipaddr.isValid(ip)) return ip;
  const parsed = ipaddr.parse(ip);
  if (parsed.kind() === 'ipv4') return parsed.toString();
  const v6 = parsed as ipaddr.IPv6;
  if (v6.isIPv4MappedAddress()) return v6.toIPv4Address().toString();
  return `${v6.parts
    .slice(0, 4)
    .map((p) => p.toString(16))
    .join(':')}::/64`;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Request ids: a caller-supplied `x-request-id` is kept for correlation when it is a plain token of
 * reasonable length; anything else (absent, oversized, odd characters) gets a fresh UUID so a
 * client can't inject arbitrary text into every log line of its request.
 */
export function requestIdFor(req: IncomingMessage): string {
  const header = req.headers['x-request-id'];
  return typeof header === 'string' && REQUEST_ID.test(header) ? header : randomUUID();
}

/** Path segments that are bearer secrets: checkout capability tokens and the Apaleo webhook token. */
const SECRET_SEGMENTS: [RegExp, string][] = [
  [/^(\/v1\/checkout\/)[^/?#]+/, '$1[redacted]'],
  [/^(\/webhooks\/apaleo\/)[^/?#]+/, '$1[redacted]'],
];

/** Query parameters that carry credentials (OAuth codes and state, tokens, keys). */
const SECRET_PARAMS = new Set([
  'code',
  'state',
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'client_secret',
  'api_key',
  'apikey',
  'key',
  'secret',
  'password',
  'signature',
]);

/** A request URL safe to log: secret path segments and credential query parameters are masked. */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  let path = q === -1 ? url : url.slice(0, q);
  for (const [pattern, replacement] of SECRET_SEGMENTS) path = path.replace(pattern, replacement);
  if (q === -1) return path;
  const params = new URLSearchParams(url.slice(q + 1));
  for (const key of [...params.keys()]) {
    if (SECRET_PARAMS.has(key.toLowerCase())) params.set(key, '[redacted]');
  }
  const query = params.toString().replace(/%5Bredacted%5D/g, '[redacted]');
  return query ? `${path}?${query}` : path;
}

/** Fastify's request log serializer, with the URL redacted. */
export function serializeRequest(req: {
  method: string;
  url: string;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number };
}) {
  return {
    method: req.method,
    url: redactUrl(req.url),
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

/**
 * The agent surface is public, cookie-less and meant for browser-based agents too, so it allows any
 * origin (never with credentials). Webhooks never answer CORS. Everything else (dashboard, checkout)
 * is called server-side by the web app; browsers may only call it from the web app's own origin.
 */
export function isPublicAgentPath(path: string): boolean {
  return (
    path === '/mcp' ||
    path.startsWith('/mcp?') ||
    path.startsWith('/v1/agent/') ||
    path.startsWith('/v1/public/') ||
    path === '/openapi.json'
  );
}

const ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Api-Key',
  'Mcp-Session-Id',
  'Mcp-Protocol-Version',
  'Last-Event-ID',
  'X-Agent-Name',
  'X-Agent-Version',
  'X-Request-Id',
];
const EXPOSED_HEADERS = [
  'Mcp-Session-Id',
  'Mcp-Protocol-Version',
  'X-Request-Id',
  'Retry-After',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
];

export function corsOptionsFor(url: string, webBaseUrl: string): FastifyCorsOptions {
  const path = url.split('?')[0] ?? url;
  if (path.startsWith('/webhooks/')) return { origin: false };
  if (isPublicAgentPath(url)) {
    return {
      origin: '*',
      credentials: false,
      methods: ['GET', 'HEAD', 'POST', 'DELETE'],
      allowedHeaders: ALLOWED_HEADERS,
      exposedHeaders: EXPOSED_HEADERS,
      maxAge: 600,
    };
  }
  return {
    origin: new URL(webBaseUrl).origin,
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ALLOWED_HEADERS,
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  };
}

/** Request body limits (bytes). Anonymous surfaces get the smallest. */
export const BODY_LIMITS = {
  /** Dashboard default: profile edits and bulk reviews stay far below this. */
  default: 256 * 1024,
  /** REST agent surface and MCP JSON-RPC messages. */
  agent: 64 * 1024,
  /** Guest details on the checkout page. */
  checkout: 16 * 1024,
  /** Provider webhooks (Stripe events can be large). */
  webhook: 1024 * 1024,
} as const;
