import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crawlSite, parseHtml } from '../src/crawl/crawler';
import {
  BlockedUrlError,
  isPrivateAddress,
  type SafeResponse,
  safeFetch,
  validateUrl,
} from '../src/crawl/safe-fetch';

describe('SSRF guard', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.9', true],
    ['192.168.1.1', true],
    ['169.254.169.254', true], // cloud metadata
    ['100.64.0.1', true], // carrier-grade NAT
    ['0.0.0.0', true],
    ['::1', true],
    ['fd00::1', true],
    ['::ffff:127.0.0.1', true],
    ['not-an-ip', true],
    ['8.8.8.8', false],
    ['2a00:1450:4001:80b::200e', false],
  ])('%s private=%s', (address, expected) => {
    expect(isPrivateAddress(address)).toBe(expected);
  });

  it.each([
    'file:///etc/passwd',
    'ftp://example.com/',
    'gopher://example.com/',
    'https://user:pw@example.com/',
    'https://example.com:22/',
    'not a url',
  ])('rejects %s', (url) => {
    expect(() => validateUrl(url)).toThrow(BlockedUrlError);
  });

  it('accepts ordinary hotel URLs', () => {
    expect(validateUrl('https://www.hotel.example/rooms?x=1').hostname).toBe('www.hotel.example');
    expect(validateUrl('http://hotel.example:8080/').port).toBe('8080');
  });
});

describe('safeFetch against a local server', () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/page' });
        return res.end();
      }
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('x'.repeat(10_000));
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><title>ok</title><p>${req.headers['user-agent']}</p></html>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('refuses loopback addresses unless private networks are allowed', async () => {
    await expect(
      safeFetch(`${origin}/page`, { allowPrivateNetworks: false, userAgent: 'test' }),
    ).rejects.toThrow(BlockedUrlError);
    const port = (server.address() as AddressInfo).port;
    // Through DNS too: "localhost" resolves to a loopback address, which the connection lookup rejects.
    await expect(
      safeFetch(`http://localhost:${port}/page`, { allowPrivateNetworks: false, userAgent: 'test' }),
    ).rejects.toThrow();
  });

  it('follows redirects, identifies itself and caps the body size', async () => {
    const res = await safeFetch(`${origin}/redirect`, {
      allowPrivateNetworks: true,
      userAgent: 'LodgentBot-test',
    });
    expect(res.url).toBe(`${origin}/page`);
    expect(res.body).toContain('LodgentBot-test');
    const big = await safeFetch(`${origin}/big`, {
      allowPrivateNetworks: true,
      userAgent: 't',
      maxBytes: 1000,
    });
    expect(big.body.length).toBeLessThanOrEqual(1000);
  });
});

describe('parseHtml', () => {
  it('keeps readable text and JSON-LD, drops scripts and styles', () => {
    const page = parseHtml(
      `<html><head><title> Rooms </title><meta name="description" content="Our rooms">
       <script>var secret = 1;</script><style>p{color:red}</style>
       <script type="application/ld+json">{"@type":"Hotel","amenityFeature":"Sauna"}</script></head>
       <body><h1>Rooms</h1><p>The   Loft has a
       sauna.</p><a href="/spa#top">Spa</a><a href="https://other.example/">Other</a></body></html>`,
      new URL('https://hotel.example/rooms'),
    );
    expect(page.title).toBe('Rooms');
    expect(page.text).toContain('Our rooms');
    expect(page.text).toContain('The Loft has a sauna.');
    expect(page.text).toContain('"amenityFeature":"Sauna"');
    expect(page.text).not.toContain('secret');
    expect(page.links.map(String)).toEqual(['https://hotel.example/spa', 'https://other.example/']);
  });
});

describe('crawlSite', () => {
  const html = (links: string[], text = 'Some text about the hotel.') =>
    `<html><title>t</title><p>${text}</p>${links.map((l) => `<a href="${l}">x</a>`).join('')}</html>`;

  function site(pages: Record<string, { status?: number; type?: string; body: string; redirect?: string }>) {
    const requested: string[] = [];
    const fetchImpl = async (url: string): Promise<SafeResponse> => {
      requested.push(url);
      const path = new URL(url).pathname;
      const page = pages[path];
      if (!page) return { url, status: 404, contentType: 'text/html', body: '' };
      return {
        url: page.redirect ?? url,
        status: page.status ?? 200,
        contentType: page.type ?? 'text/html',
        body: page.body,
      };
    };
    return { requested, fetchImpl: fetchImpl as unknown as typeof safeFetch };
  }

  it('stays on site, honours robots.txt and fetches likely-relevant pages first', async () => {
    const { requested, fetchImpl } = site({
      '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /private/\n' },
      '/': {
        body: html([
          '/blog/1',
          '/blog/2',
          '/rooms/',
          '/private/admin',
          'https://elsewhere.example/',
          '/brochure.pdf',
          '/rooms/#gallery',
        ]),
      },
      '/rooms/': { body: html(['/spa']) },
      '/spa': { body: html([]) },
      '/blog/1': { body: html([]) },
      '/blog/2': { body: html([]) },
    });
    const sleeps: number[] = [];
    const result = await crawlSite('https://hotel.example/', {
      allowPrivateNetworks: false,
      fetchImpl,
      delayMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const paths = result.pages.map((p) => new URL(p.url).pathname);
    expect(paths.slice(0, 3)).toEqual(['/', '/rooms/', '/spa']);
    expect(paths).toHaveLength(5);
    expect(result.skipped).toEqual([{ url: 'https://hotel.example/private/admin', reason: 'robots.txt' }]);
    expect(requested.some((u) => u.includes('elsewhere') || u.endsWith('.pdf'))).toBe(false);
    expect(sleeps.every((ms) => ms === 10)).toBe(true);
  });

  it('respects Crawl-delay (capped), the page limit, non-HTML and off-site redirects', async () => {
    const links = Array.from({ length: 40 }, (_, i) => `/p${i}`);
    const pages: Record<string, { body: string; type?: string; redirect?: string }> = {
      '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nCrawl-delay: 30\n' },
      '/': { body: html(['/feed', '/moved', ...links]) },
      '/feed': { type: 'application/rss+xml', body: '<rss/>' },
      '/moved': { body: html([]), redirect: 'https://booking-engine.example/start' },
    };
    for (const l of links) pages[l] = { body: html([]) };
    const { fetchImpl } = site(pages);
    const sleeps: number[] = [];
    const result = await crawlSite('https://hotel.example/', {
      allowPrivateNetworks: false,
      fetchImpl,
      maxPages: 100,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result.pages).toHaveLength(30);
    expect(sleeps.every((ms) => ms === 5000)).toBe(true);
    expect(result.skipped.map((s) => s.reason)).toEqual(
      expect.arrayContaining(['HTTP 200 application/rss+xml', 'redirected off-site']),
    );
  });
});
