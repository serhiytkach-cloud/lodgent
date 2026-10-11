import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import ipaddr from 'ipaddr.js';
import { Agent, type Dispatcher, request } from 'undici';

export class BlockedUrlError extends Error {}

/** Resolves a hostname to every address it has (the system resolver by default). */
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

export interface SafeFetchOptions {
  allowPrivateNetworks: boolean;
  userAgent: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  accept?: string;
  /** DNS resolver; tests inject a fake one to simulate hostile DNS answers. */
  resolver?: Resolver;
  /**
   * Which resolved or literal addresses are refused. Defaults to `isPrivateAddress` (nothing when
   * private networks are allowed). Only tests override it, to stand a local server in for a public one.
   */
  isBlockedAddress?: (address: string) => boolean;
}

export interface SafeResponse {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

/** IPv6 blocks that ipaddr.js labels "unicast" but must never be reached from the crawler. */
const EXTRA_BLOCKED_V6: [ipaddr.IPv6, number][] = [
  // IPv4-compatible addresses (deprecated, ::a.b.c.d): some stacks still route them to IPv4.
  [ipaddr.IPv6.parse('::'), 96],
];

/**
 * True for addresses an external crawler must never reach: loopback, RFC 1918, link-local (which
 * includes the cloud metadata service 169.254.169.254 and ECS 169.254.170.2), CGNAT, unique-local
 * (fd00::/8, incl. fd00:ec2::254), multicast, reserved and documentation ranges, NAT64/6to4/Teredo
 * (which embed IPv4 addresses), IPv4-mapped and IPv4-compatible forms of any of these, and anything
 * that is not a valid IP address at all. Only globally routable unicast addresses pass.
 */
export function isPrivateAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return true;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) parsed = v6.toIPv4Address();
    else if (EXTRA_BLOCKED_V6.some((range) => v6.match(range))) return true;
  }
  return parsed.range() !== 'unicast';
}

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

/**
 * Checks a URL before any request: http(s) only, no embedded credentials, standard web ports (any
 * port only when private networks are allowed, for local demo sites). Hostnames arrive here already
 * normalized by the WHATWG URL parser, so decimal, octal and hex IPv4 spellings (2130706433,
 * 0177.0.0.1, 0x7f.1) have become dotted quads and are caught by the address check.
 */
export function validateUrl(raw: string, options: { allowPrivateNetworks?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError(`Invalid URL: ${raw.slice(0, 200)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new BlockedUrlError('Only http and https URLs are allowed');
  if (url.username || url.password) throw new BlockedUrlError('URLs with credentials are not allowed');
  if (!ALLOWED_PORTS.has(url.port) && !options.allowPrivateNetworks) {
    throw new BlockedUrlError(`Port ${url.port} is not allowed`);
  }
  return url;
}

/** The hostname as an IP literal, or null when it is a DNS name. */
function ipLiteral(hostname: string): string | null {
  const bare = hostname.replace(/^\[|\]$/g, '');
  return ipaddr.isValid(bare) ? bare : null;
}

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) =>
    dnsLookup(hostname, { all: true }, (error, addresses) => (error ? reject(error) : resolve(addresses))),
  );

type LookupCallback = (error: Error | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A connection-time DNS lookup that drops refused addresses. Because the check runs inside the
 * connection's own lookup, the address that was validated is the address the socket connects to:
 * there is no window between a check and the request for DNS rebinding.
 */
export function guardedLookup(resolver: Resolver, isBlocked: (address: string) => boolean) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    resolver(hostname).then(
      (addresses) => {
        const allowed = addresses.filter((a) => !isBlocked(a.address));
        if (allowed.length === 0) {
          callback(new BlockedUrlError(`${hostname} resolves to a private or reserved address`), []);
          return;
        }
        if (options.all) callback(null, allowed);
        else callback(null, allowed[0]!.address, allowed[0]!.family);
      },
      (error: Error) => callback(error, []),
    );
  };
}

function createAgent(resolver: Resolver, isBlocked: (address: string) => boolean): Agent {
  return new Agent({
    connect: { lookup: guardedLookup(resolver, isBlocked) as never },
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
  });
}

const sharedAgents = new Map<boolean, Agent>();

/** The shared connection pool, or a one-off agent (closed after the request) for custom resolvers. */
function dispatcherFor(
  options: SafeFetchOptions,
  isBlocked: (address: string) => boolean,
): { dispatcher: Dispatcher; dispose: () => Promise<void> } {
  if (options.resolver || options.isBlockedAddress) {
    const agent = createAgent(options.resolver ?? systemResolver, isBlocked);
    return { dispatcher: agent, dispose: () => agent.close() };
  }
  let agent = sharedAgents.get(options.allowPrivateNetworks);
  if (!agent) {
    agent = createAgent(systemResolver, isBlocked);
    sharedAgents.set(options.allowPrivateNetworks, agent);
  }
  return { dispatcher: agent, dispose: async () => {} };
}

/**
 * Fetches a URL for the website crawler: http(s) only, no credentials, no private networks (unless
 * explicitly allowed for local development), manual redirects re-validated hop by hop (URL, literal
 * address and the connection's DNS answer), response size and time limits.
 */
export async function safeFetch(raw: string, options: SafeFetchOptions): Promise<SafeResponse> {
  const isBlocked =
    options.isBlockedAddress ?? (options.allowPrivateNetworks ? () => false : isPrivateAddress);
  const { dispatcher, dispose } = dispatcherFor(options, isBlocked);
  try {
    return await fetchFollowingRedirects(raw, options, dispatcher, isBlocked);
  } finally {
    await dispose();
  }
}

async function fetchFollowingRedirects(
  raw: string,
  options: SafeFetchOptions,
  dispatcher: Dispatcher,
  isBlocked: (address: string) => boolean,
): Promise<SafeResponse> {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  let url = validateUrl(raw, options);
  for (let hop = 0; hop <= (options.maxRedirects ?? 5); hop++) {
    // IP literals never reach the lookup, so they are checked here.
    const literal = ipLiteral(url.hostname);
    if (literal && isBlocked(literal)) throw new BlockedUrlError('Private or reserved address');
    const res = await request(url, {
      dispatcher,
      method: 'GET',
      headers: {
        'user-agent': options.userAgent,
        accept: options.accept ?? 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5',
        'accept-language': 'en',
      },
      signal: deadline,
    });
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      await res.body.dump();
      url = validateUrl(new URL(String(res.headers.location), url).toString(), options);
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
