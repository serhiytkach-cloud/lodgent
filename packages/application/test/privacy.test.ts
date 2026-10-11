import { Writable } from 'node:stream';
import { UpstreamError } from '@lodgent/core';
import type { Database, NewAgentEvent, NewAgentQuery } from '@lodgent/db';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { DEV_SECRETS } from '../src/config';
import { Signer } from '../src/infra/signing';
import {
  privacyLoggerOptions,
  redactUrl,
  scrubEmails,
  serializeError,
  serializeRequest,
  truncateIp,
} from '../src/logging';
import { AgentLog } from '../src/services/agent-log';

/** A pino logger with the production privacy options, writing JSON lines into memory. */
function memoryLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const logger = pino({ level: 'info', ...privacyLoggerOptions }, stream);
  return { logger, output: () => lines.join('') };
}

describe('PII-safe logging', () => {
  it('redacts guest fields and credentials by path', () => {
    const { logger, output } = memoryLogger();
    logger.info(
      {
        bookingId: 'b-1',
        email: 'ana@example.com',
        guest: { firstName: 'Ana', lastName: 'Silva', email: 'ana@example.com', phone: '+351 912 000 000' },
        booking: {
          guestFirstName: 'Ana',
          guestLastName: 'Silva',
          guestEmail: 'ana@example.com',
          guestPhone: '+351 912 000 000',
          specialRequests: 'Allergic to nuts',
        },
        connection: { accessToken: 'at', refreshToken: 'rt', clientSecret: 'cs' },
      },
      'something happened',
    );
    const out = output();
    expect(out).toContain('"bookingId":"b-1"');
    for (const secret of ['ana@example.com', 'Silva', '912 000', 'nuts', '"at"', '"rt"', '"cs"']) {
      expect(out).not.toContain(secret);
    }
  });

  it('masks email addresses anywhere in serialized errors', () => {
    const error = new UpstreamError('apaleo', 'Apaleo returned 422 for POST /booking/v1/bookings', {
      status: 422,
      body: '{"messages":["Guest email ana.silva@example.com is invalid"]}',
    });
    const serialized = JSON.stringify(serializeError(error));
    expect(serialized).toContain('Apaleo returned 422');
    expect(serialized).toContain('[email]');
    expect(serialized).not.toContain('ana.silva@example.com');

    const { logger, output } = memoryLogger();
    logger.warn({ err: new Error('SES rejected bob@example.org') }, 'delivery failed');
    expect(output()).toContain('SES rejected [email]');
    expect(output()).not.toContain('bob@example.org');
  });

  it('scrubs emails from free text', () => {
    expect(scrubEmails('to Ana.Silva+test@mail.example.co.uk, cc x@y.io')).toBe('to [email], cc [email]');
    expect(scrubEmails('no address here, 2026-10-11 12:00')).toBe('no address here, 2026-10-11 12:00');
  });

  it('removes tokens and personal data from request URLs', () => {
    expect(redactUrl('/v1/checkout/eyJoIjoiYWJjIn0.c2ln/guest')).toBe('/v1/checkout/[redacted]/guest');
    expect(redactUrl('/webhooks/apaleo/secret-token')).toBe('/webhooks/apaleo/[redacted]');
    expect(redactUrl('/v1/orgs/o1/bookings?q=Silva&limit=10&status=confirmed')).toBe(
      '/v1/orgs/o1/bookings?q=[redacted]&limit=10&status=confirmed',
    );
    expect(redactUrl('/v1/integrations/apaleo/callback?code=abc&state=xyz')).toBe(
      '/v1/integrations/apaleo/callback?code=[redacted]&state=[redacted]',
    );
    expect(redactUrl('/v1/agent/hotels/h1/offers?checkIn=2026-11-10&adults=2')).toBe(
      '/v1/agent/hotels/h1/offers?checkIn=2026-11-10&adults=2',
    );
    expect(redactUrl('/v1/orgs/o1/bookings?Q=Silva&flag')).toBe('/v1/orgs/o1/bookings?Q=[redacted]&flag');
  });

  it('truncates client IPs', () => {
    expect(truncateIp('203.0.113.77')).toBe('203.0.113.0');
    expect(truncateIp('::ffff:203.0.113.77')).toBe('203.0.113.0');
    expect(truncateIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3::/48');
    expect(truncateIp('2001:db8::1')).toBe('2001:db8::/48');
    expect(truncateIp(undefined)).toBeUndefined();
    expect(truncateIp('not-an-ip')).toBeUndefined();
  });

  it('serializes requests like Fastify, minus tokens, search terms and full IPs', () => {
    expect(
      serializeRequest({
        method: 'GET',
        url: '/v1/orgs/o1/bookings?q=Silva',
        host: 'api.test',
        ip: '198.51.100.23',
        headers: { authorization: 'Bearer secret' },
        socket: { remotePort: 51234 },
      }),
    ).toEqual({
      method: 'GET',
      url: '/v1/orgs/o1/bookings?q=[redacted]',
      version: undefined,
      host: 'api.test',
      remoteAddress: '198.51.100.0',
      remotePort: 51234,
    });
  });
});

describe('pseudonymous guest references', () => {
  it('are keyed, stable and purpose-bound', () => {
    const signer = new Signer(DEV_SECRETS.signingSecret);
    const a = signer.digest('guest-ref', 'org-1\nana@example.com');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(signer.digest('guest-ref', 'org-1\nana@example.com')).toBe(a);
    expect(signer.digest('guest-ref', 'org-2\nana@example.com')).not.toBe(a);
    expect(signer.digest('checkout', 'org-1\nana@example.com')).not.toBe(a);
    expect(
      new Signer(`${DEV_SECRETS.signingSecret}-other`).digest('guest-ref', 'org-1\nana@example.com'),
    ).not.toBe(a);
  });
});

describe('agent query log', () => {
  it('masks contact details in free-text fields before they are stored', async () => {
    const queries: NewAgentQuery[] = [];
    const events: NewAgentEvent[] = [];
    const db = {
      system: async <T>(fn: (repos: unknown) => Promise<T>) =>
        fn({
          agentLog: {
            insertQuery: async (values: NewAgentQuery) => {
              queries.push(values);
              return 'q-1';
            },
            insertEvents: async (values: NewAgentEvent[]) => {
              events.push(...values);
            },
          },
        }),
    } as unknown as Database;
    const log = new AgentLog(db, pino({ level: 'silent' }));
    await log.record(
      {
        partnerId: null,
        channel: 'mcp',
        clientName: 'bot for ana@example.com',
        utm: { source: 'https://tracker.test/?id=123456', medium: null, campaign: null },
      },
      { tool: 'search_hotels', destination: 'Lisbon, for ana@example.com, call +351 912 345 678' },
      [{ organizationId: 'o-1', propertyId: 'p-1', kind: 'search_impression', rank: 1 }],
    );
    const stored = JSON.stringify({ queries, events });
    expect(queries[0]).toMatchObject({
      destination: 'Lisbon, for [email] call [number]',
      clientName: 'bot for [email]',
      utmSource: '[url]',
    });
    expect(events[0]).toMatchObject({ clientName: 'bot for [email]', queryId: 'q-1' });
    expect(stored).not.toMatch(/ana@|912|example\.com/);
  });
});
