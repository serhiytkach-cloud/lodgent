import type { PageContent } from '@lodgent/core';
import { BRAND } from '@lodgent/shared';
import * as cheerio from 'cheerio';
import robotsParser from 'robots-parser';
import { BlockedUrlError, safeFetch } from './safe-fetch';

export const CRAWLER_USER_AGENT = `${BRAND.name}Bot/1.0 (+hotel profile import; contact via the hotel's ${BRAND.name} account)`;

export interface CrawlOptions {
  maxPages?: number;
  /** Minimum delay between requests (robots.txt Crawl-delay raises it, capped at 5 s). */
  delayMs?: number;
  allowPrivateNetworks: boolean;
  fetchImpl?: typeof safeFetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface CrawlResult {
  pages: PageContent[];
  skipped: { url: string; reason: string }[];
}

const SKIP_EXTENSIONS = /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|json|xml|zip|mp4|mp3|woff2?|ttf|ics)$/i;
const PRIORITY =
  /(room|suite|amenit|facilit|service|about|spa|wellness|dining|restaurant|bar|breakfast|faq|location|getting-here|policies|policy|family|kids|pet|dog|access|sustainab|green|meeting|event|gallery)/i;

function hostKey(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

function normalize(href: string, base: URL): URL | null {
  try {
    const url = new URL(href, base);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_)/i.test(key)) url.searchParams.delete(key);
    }
    return url;
  } catch {
    return null;
  }
}

/** Readable text, title and links from an HTML page. JSON-LD blocks are kept as text (they often list amenities). */
export function parseHtml(html: string, pageUrl: URL): { title: string | null; text: string; links: URL[] } {
  const $ = cheerio.load(html);
  const jsonLd = $('script[type="application/ld+json"]')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((t) => t.length > 0 && t.length < 20_000);
  const title = $('title').first().text().trim() || null;
  const description = $('meta[name="description"]').attr('content')?.trim() ?? '';
  const links = $('a[href]')
    .map((_, el) => normalize($(el).attr('href') ?? '', pageUrl))
    .get()
    .filter((u): u is URL => u !== null);
  $('script, style, noscript, svg, iframe, template, form').remove();
  const blocks: string[] = [];
  $('h1, h2, h3, h4, p, li, dt, dd, td, th, blockquote, figcaption, address').each((_, el) => {
    const text = $(el).clone().children('ul,ol').remove().end().text().replace(/\s+/g, ' ').trim();
    if (text.length >= 3) blocks.push(text);
  });
  const deduped = [...new Set(blocks)];
  const parts = [description, ...deduped];
  if (jsonLd.length > 0) parts.push(`Structured data: ${jsonLd.join(' ')}`);
  return { title, text: parts.filter(Boolean).join('\n'), links };
}

/**
 * Polite, bounded crawl of a hotel website: same host only, robots.txt respected, at most
 * `maxPages` HTML pages (default 30), pages likely to describe the hotel fetched first.
 */
export async function crawlSite(startUrl: string, options: CrawlOptions): Promise<CrawlResult> {
  const fetchPage = options.fetchImpl ?? safeFetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxPages = Math.min(options.maxPages ?? 30, 30);
  const start = new URL(startUrl);
  const host = hostKey(start.hostname);
  const fetchOpts = { allowPrivateNetworks: options.allowPrivateNetworks, userAgent: CRAWLER_USER_AGENT };

  let delayMs = options.delayMs ?? 500;
  let robots: ReturnType<typeof robotsParser> | null = null;
  try {
    const robotsUrl = new URL('/robots.txt', start).toString();
    const res = await fetchPage(robotsUrl, { ...fetchOpts, maxBytes: 256 * 1024, accept: 'text/plain' });
    if (res.status === 200) {
      robots = robotsParser(robotsUrl, res.body);
      const crawlDelay = robots.getCrawlDelay(CRAWLER_USER_AGENT);
      if (crawlDelay) delayMs = Math.min(Math.max(delayMs, crawlDelay * 1000), 5000);
    }
  } catch (error) {
    if (error instanceof BlockedUrlError) throw error;
    // No robots.txt reachable: crawl conservatively with the default delay.
  }

  const queue: URL[] = [start];
  const seen = new Set<string>([start.toString()]);
  const pages: PageContent[] = [];
  const skipped: CrawlResult['skipped'] = [];

  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift()!;
    if (robots && robots.isAllowed(url.toString(), CRAWLER_USER_AGENT) === false) {
      skipped.push({ url: url.toString(), reason: 'robots.txt' });
      continue;
    }
    if (pages.length > 0) await sleep(delayMs);
    let res: Awaited<ReturnType<typeof safeFetch>>;
    try {
      res = await fetchPage(url.toString(), fetchOpts);
    } catch (error) {
      if (error instanceof BlockedUrlError && pages.length === 0) throw error;
      skipped.push({ url: url.toString(), reason: error instanceof Error ? error.message : 'fetch failed' });
      continue;
    }
    if (res.status !== 200 || !/html/i.test(res.contentType)) {
      skipped.push({ url: url.toString(), reason: `HTTP ${res.status} ${res.contentType}`.trim() });
      continue;
    }
    const finalUrl = new URL(res.url);
    if (hostKey(finalUrl.hostname) !== host) {
      skipped.push({ url: url.toString(), reason: 'redirected off-site' });
      continue;
    }
    // A redirect can land on a page we already have.
    if (finalUrl.toString() !== url.toString() && pages.some((p) => p.url === finalUrl.toString())) continue;
    seen.add(finalUrl.toString());
    const parsed = parseHtml(res.body, finalUrl);
    pages.push({ url: finalUrl.toString(), title: parsed.title, text: parsed.text.slice(0, 50_000) });

    for (const link of parsed.links) {
      const key = link.toString();
      if (
        (link.protocol === 'http:' || link.protocol === 'https:') &&
        hostKey(link.hostname) === host &&
        !SKIP_EXTENSIONS.test(link.pathname) &&
        !seen.has(key)
      ) {
        seen.add(key);
        queue.push(link);
      }
    }
    // Visit pages that likely describe rooms, amenities and policies first.
    queue.sort((a, b) => Number(PRIORITY.test(b.pathname)) - Number(PRIORITY.test(a.pathname)));
  }
  return { pages, skipped };
}
