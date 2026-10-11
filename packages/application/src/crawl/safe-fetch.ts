import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';

export class BlockedUrlError extends Error {}

export interface SafeFetchOptions {
  allowPrivateNetworks: boolean;
  userAgent: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  accept?: string;
}

export interface SafeResponse {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

/** True for addresses an external crawler must never reach (loopback, RFC1918, link-local, metadata…). */
export function isPrivateAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return true;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return parsed.range() !== 'unicast';
}

export function validateUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new BlockedUrlError('Only http and https URLs are allowed');
  if (url.username || url.password) throw new BlockedUrlError('URLs with credentials are not allowed');
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port) && !isLocalhost(url.hostname)) {
    throw new BlockedUrlError(`Port ${url.port} is not allowed`);
  }
  return url;
}

function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * An undici agent whose DNS lookup refuses private addresses. Because the check happens in the
 * connection's own lookup, the address we validate is the address we connect to (no DNS-rebinding
 * window between a check and the request).
 */
function guardedAgent(allowPrivate: boolean): Agent {
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        dnsLookup(hostname, { all: true }, (error, addresses: LookupAddress[]) => {
          if (error) return callback(error, [] as never, 0 as never);
          const allowed = addresses.filter((a) => allowPrivate || !isPrivateAddress(a.address));
          if (allowed.length === 0) {
            return callback(
              new BlockedUrlError(`${hostname} resolves to a private address`),
              [] as never,
              0 as never,
            );
          }
          if ((options as { all?: boolean }).all) return callback(null, allowed as never, 0 as never);
          return callback(null, allowed[0]!.address, allowed[0]!.family);
        });
      },
    },
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
  });
}

const agents = new Map<boolean, Agent>();

/**
 * Fetches a URL for the website crawler: http(s) only, no credentials, no private networks (unless
 * explicitly allowed for local development), manual redirects re-validated hop by hop, response
 * size and time limits.
 */
export async function safeFetch(raw: string, options: SafeFetchOptions): Promise<SafeResponse> {
  let agent = agents.get(options.allowPrivateNetworks);
  if (!agent) {
    agent = guardedAgent(options.allowPrivateNetworks);
    agents.set(options.allowPrivateNetworks, agent);
  }
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  let url = validateUrl(raw);
  for (let hop = 0; hop <= (options.maxRedirects ?? 5); hop++) {
    if (!options.allowPrivateNetworks && ipaddr.isValid(url.hostname.replace(/^\[|\]$/g, ''))) {
      if (isPrivateAddress(url.hostname.replace(/^\[|\]$/g, '')))
        throw new BlockedUrlError('Private address');
    }
    const res = await request(url, {
      dispatcher: agent,
      method: 'GET',
      headers: {
        'user-agent': options.userAgent,
        accept: options.accept ?? 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5',
        'accept-language': 'en',
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      await res.body.dump();
      url = validateUrl(new URL(String(res.headers.location), url).toString());
      continue;
    }
    const contentType = String(res.headers['content-type'] ?? '');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) {
        res.body.destroy();
        break;
      }
      chunks.push(chunk as Buffer);
    }
    return {
      url: url.toString(),
      status: res.statusCode,
      contentType,
      body: Buffer.concat(chunks).toString('utf8'),
    };
  }
  throw new BlockedUrlError('Too many redirects');
}
