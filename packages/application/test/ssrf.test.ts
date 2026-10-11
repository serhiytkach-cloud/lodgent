import type { LookupAddress } from 'node:dns';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crawlSite } from '../src/crawl/crawler';
import {
  BlockedUrlError,
  guardedLookup,
  isPrivateAddress,
  type Resolver,
  safeFetch,
  validateUrl,
} from '../src/crawl/safe-fetch';

/** A fake DNS: hostname → addresses (or a function returning them, to simulate rebinding). */
function fakeResolver(table: Record<string, string[] | (() => string[])>): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const resolver = async (hostname: string): Promise<LookupAddress[]> => {
    calls.push(hostname);
    const entry = table[hostname];
    if (!entry) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    const addresses = typeof entry === 'function' ? entry() : entry;
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return Object.assign(resolver, { calls });
}

const base = { userAgent: 'LodgentBot-test', allowPrivateNetworks: false } as const;

describe('isPrivateAddress covers every non-public range', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.169.254', // EC2 instance metadata
    '169.254.170.2', // ECS task metadata
    '100.100.100.200', // carrier-grade NAT (also Alibaba metadata)
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '198.18.0.1',
    '192.0.2.10',
    '240.0.0.1',
    '::',
    '::1',
    'fe80::1',
    'fec0::1',
    'fd00::1',
    'fd00:ec2::254', // EC2 IPv6 metadata
    'fc00::1',
    'ff02::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:169.254.169.254', // IPv4-mapped metadata
    '::ffff:a9fe:a9fe', // the same, in hex
    '::7f00:1', // IPv4-compatible loopback
    '64:ff9b::a9fe:a9fe', // NAT64 of the metadata address
    '2002:a9fe:a9fe::1', // 6to4 of the metadata address
    '2001:db8::1',
    'fe80::1%eth0', // zone ids are not plain addresses
    'localhost',
    '',
  ])('blocks %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e'])(
    'allows %s',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

describe('safeFetch refuses private targets before connecting', () => {
  it.each([
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://2130706433/', // decimal 127.0.0.1
    'http://017700000001/', // octal
    'http://0x7f000001/', // hex
    'http://0x7f.1/', // mixed short form
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://0/', // 0.0.0.0
    'http://[::]/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'http://[64:ff9b::a9fe:a9fe]/',
  ])('%s', async (url) => {
    // An unreachable resolver proves IP literals never get as far as DNS or a socket.
    const resolver = fakeResolver({});
    await expect(safeFetch(url, { ...base, resolver })).rejects.toBeInstanceOf(BlockedUrlError);
    expect(resolver.calls).toEqual([]);
  });

  it('refuses non-web schemes, credentials and unusual ports', async () => {
    for (const url of [
      'file:///etc/passwd',
      'gopher://hotel.example/',
      'ftp://hotel.example/',
      'https://user:pw@hotel.example/',
      'https://hotel.example:6379/',
      'http://hotel.example:2375/',
    ]) {
      await expect(safeFetch(url, base), url).rejects.toBeInstanceOf(BlockedUrlError);
    }
    expect(validateUrl('https://hotel.example:6379/', { allowPrivateNetworks: true }).port).toBe('6379');
  });

  it('refuses hostnames whose DNS answers are all private', async () => {
    const resolver = fakeResolver({
      'metadata.hotel.test': ['169.254.169.254'],
      'intranet.hotel.test': ['10.0.0.5', 'fd12::5'],
      'mapped.hotel.test': ['::ffff:10.0.0.5'],
    });
    for (const host of ['metadata.hotel.test', 'intranet.hotel.test', 'mapped.hotel.test']) {
      await expect(safeFetch(`http://${host}/`, { ...base, resolver }), host).rejects.toBeInstanceOf(
        BlockedUrlError,
      );
    }
  });

  it('the connection lookup only ever hands out allowed addresses', async () => {
    const resolver = fakeResolver({ 'mixed.hotel.test': ['127.0.0.1', '93.184.216.34', '10.1.1.1'] });
    const lookup = guardedLookup(resolver, isPrivateAddress);
    const all = await new Promise<unknown>((resolve, reject) =>
      lookup('mixed.hotel.test', { all: true }, (error, addresses) =>
        error ? reject(error) : resolve(addresses),
      ),
    );
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
    const one = await new Promise<unknown>((resolve, reject) =>
      lookup('mixed.hotel.test', {}, (error, address) => (error ? reject(error) : resolve(address))),
    );
    expect(one).toBe('93.184.216.34');
  });
});

describe('safeFetch against a local server standing in for a public site', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const redirect = (location: string) => {
        res.writeHead(302, { location, connection: 'close' });
        res.end();
      };
      switch (req.url) {
        case '/to-metadata':
          return redirect('http://169.254.169.254/latest/meta-data/');
        case '/to-decimal':
          return redirect('http://2130706434/'); // 127.0.0.2
        case '/to-mapped':
          return redirect('http://[::ffff:7f00:2]/');
        case '/to-internal-name':
          return redirect(`http://intranet.hotel.test:${port}/`);
        case '/to-file':
          return redirect('file:///etc/passwd');
        case '/to-ok':
          return redirect('/ok');
        case '/loop':
          return redirect('/loop');
        default:
          res.writeHead(200, { 'content-type': 'text/html', connection: 'close' });
          res.end('<title>ok</title>');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  // 127.0.0.1 plays a public address; every other private address stays blocked.
  const pretendPublic = (address: string) => address !== '127.0.0.1' && isPrivateAddress(address);
  const options = (resolver: Resolver) => ({
    ...base,
    resolver,
    isBlockedAddress: pretendPublic,
    // Local test ports are not standard web ports.
    allowPrivateNetworks: true,
  });

  it('follows a redirect that stays public', async () => {
    const resolver = fakeResolver({ 'hotel.test': ['127.0.0.1'] });
    const res = await safeFetch(`http://hotel.test:${port}/to-ok`, options(resolver));
    expect(res.status).toBe(200);
    expect(res.url).toBe(`http://hotel.test:${port}/ok`);
  });

  it.each(['/to-metadata', '/to-decimal', '/to-mapped', '/to-internal-name', '/to-file'])(
    'refuses a redirect hop %s',
    async (path) => {
      const resolver = fakeResolver({ 'hotel.test': ['127.0.0.1'], 'intranet.hotel.test': ['10.0.0.7'] });
      await expect(safeFetch(`http://hotel.test:${port}${path}`, options(resolver))).rejects.toBeInstanceOf(
        BlockedUrlError,
      );
    },
  );

  it('stops redirect loops', async () => {
    const resolver = fakeResolver({ 'hotel.test': ['127.0.0.1'] });
    await expect(
      safeFetch(`http://hotel.test:${port}/loop`, { ...options(resolver), maxRedirects: 3 }),
    ).rejects.toThrow(/Too many redirects/);
  });

  it('defeats DNS rebinding: every new connection re-resolves and re-checks', async () => {
    let answers = 0;
    // First answer is "public", every later answer points inside the network.
    const resolver = fakeResolver({
      'rebind.hotel.test': () => (answers++ === 0 ? ['127.0.0.1'] : ['127.0.0.2']),
    });
    const first = await safeFetch(`http://rebind.hotel.test:${port}/ok`, options(resolver));
    expect(first.status).toBe(200);
    await expect(safeFetch(`http://rebind.hotel.test:${port}/ok`, options(resolver))).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    expect(resolver.calls).toEqual(['rebind.hotel.test', 'rebind.hotel.test']);
  });
});

describe('crawlSite', () => {
  it('fails fast when the hotel website points at the metadata service', async () => {
    await expect(
      crawlSite('http://169.254.169.254/latest/meta-data/', { allowPrivateNetworks: false, delayMs: 0 }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });
});
