import { createJobHandlers, RETENTION } from '@lodgent/application';
import { sql } from '@lodgent/db';
import { addDays, localDateAt } from '@lodgent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, newOrg, type TestApp } from './helpers';
import { type SeededHotel, seedBooking, seedHotel } from './seed-bookings';

let app: TestApp;
let orgId: string;
let hotel: SeededHotel;
const DAY = 86_400_000;
const today = localDateAt(new Date(), 'UTC');
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

async function query<T>(text: ReturnType<typeof sql>): Promise<T[]> {
  return app.container.db.system(async ({ tx }) => (await tx.execute(text)).rows as T[]);
}

beforeAll(async () => {
  // PII_RETENTION_DAYS defaults to 30.
  app = await createTestApp();
  ({ orgId } = await newOrg(app, 'Retention Hotels'));
  hotel = await seedHotel(app, orgId);
});

afterAll(async () => {
  await app.close();
});

describe('privacy retention job', () => {
  const ids: Record<string, string> = {};
  let alreadyRedactedAt: Date;

  beforeAll(async () => {
    // Bookings: one per retention rule, on both sides of each cutoff.
    ids.departedLongAgo = (
      await seedBooking(app, hotel, {
        email: 'a@example.com',
        arrival: addDays(today, -45),
        departure: addDays(today, -40),
      })
    ).id;
    ids.departedRecently = (
      await seedBooking(app, hotel, {
        email: 'b@example.com',
        arrival: addDays(today, -7),
        departure: addDays(today, -5),
      })
    ).id;
    ids.upcoming = (
      await seedBooking(app, hotel, {
        email: 'c@example.com',
        arrival: addDays(today, 5),
        departure: addDays(today, 7),
      })
    ).id;
    ids.failedLongAgo = (
      await seedBooking(app, hotel, {
        email: 'd@example.com',
        status: 'failed',
        arrival: addDays(today, 30),
        departure: addDays(today, 32),
      })
    ).id;
    ids.failedRecently = (
      await seedBooking(app, hotel, {
        email: 'e@example.com',
        status: 'failed',
        arrival: addDays(today, 30),
        departure: addDays(today, 32),
      })
    ).id;
    ids.alreadyRedacted = (
      await seedBooking(app, hotel, {
        email: null,
        arrival: addDays(today, -90),
        departure: addDays(today, -88),
      })
    ).id;
    alreadyRedactedAt = daysAgo(50);
    await app.container.db.tenant(orgId, async (r) => {
      await r.bookings.update(ids.failedLongAgo!, {
        updatedAt: daysAgo(RETENTION.failedCheckoutPiiDays + 1),
      });
      await r.bookings.update(ids.failedRecently!, {
        updatedAt: daysAgo(RETENTION.failedCheckoutPiiDays - 2),
      });
      await r.bookings.update(ids.alreadyRedacted!, {
        guestFirstName: null,
        guestLastName: null,
        guestPhone: null,
        specialRequests: null,
        piiRedactedAt: alreadyRedactedAt,
      });
    });

    // Outbox: delivered (old and recent), undeliverable emails (old and recent), an old pending job.
    await query(sql`
      insert into outbox (organization_id, topic, payload, created_at, available_at, dispatched_at, attempts, last_error) values
        (${orgId}, 'email.send', '{"scrubbed":true}', ${daysAgo(10)}, ${daysAgo(10)}, ${daysAgo(10)}, 0, null),
        (${orgId}, 'job.enqueue', '{"type":"pms.sync","payload":{}}', ${daysAgo(1)}, ${daysAgo(1)}, ${daysAgo(1)}, 0, null),
        (${orgId}, 'email.send', '{"to":"stuck@example.com","template":"booking-confirmation","data":{}}', ${daysAgo(5)}, ${daysAgo(0)}, null, 40, 'Rejected: stuck@example.com'),
        (${orgId}, 'email.send', '{"to":"slow@example.com","template":"booking-confirmation","data":{}}', ${daysAgo(1)}, ${daysAgo(0)}, null, 3, 'timeout'),
        (${orgId}, 'job.enqueue', '{"type":"pms.sync","payload":{}}', ${daysAgo(5)}, ${daysAgo(0)}, null, 10, 'queue down')
    `);
    // Jobs (local Postgres queue): completed and failed on both sides of their cutoffs, one pending.
    await query(sql`
      insert into jobs (type, payload, completed_at, failed_at, created_at) values
        ('old.completed', '{}', ${daysAgo(RETENTION.completedJobDays + 1)}, null, ${daysAgo(20)}),
        ('new.completed', '{}', ${daysAgo(1)}, null, ${daysAgo(1)}),
        ('old.failed', '{}', null, ${daysAgo(RETENTION.failedJobDays + 1)}, ${daysAgo(40)}),
        ('new.failed', '{}', null, ${daysAgo(RETENTION.failedJobDays - 5)}, ${daysAgo(25)}),
        ('pending', '{}', null, null, ${daysAgo(60)})
    `);
    await query(sql`
      insert into webhook_events (provider, event_id, type, created_at) values
        ('stripe', 'evt_old', 'payment_intent.succeeded', ${daysAgo(RETENTION.webhookEventDays + 1)}),
        ('stripe', 'evt_new', 'payment_intent.succeeded', ${daysAgo(2)})
    `);
  });

  it('erases guest details and purges PII-carrying rows past retention, in small batches', async () => {
    const result = await app.container.services.privacy.runRetention({ batchSize: 1 });
    expect(result).toEqual({
      bookingsRedacted: 2,
      outboxDeleted: 1,
      undeliveredEmailsDropped: 1,
      jobsDeleted: 2,
      webhookEventsDeleted: 1,
    });

    const bookings = await query<{ id: string; guest_email: string | null; pii_redacted_at: string | null }>(
      sql`select id, guest_email, pii_redacted_at from bookings where organization_id = ${orgId}`,
    );
    const byId = Object.fromEntries(bookings.map((b) => [b.id, b]));
    for (const key of ['departedLongAgo', 'failedLongAgo']) {
      expect(byId[ids[key]!], key).toMatchObject({ guest_email: null, pii_redacted_at: expect.any(String) });
    }
    for (const key of ['departedRecently', 'upcoming', 'failedRecently']) {
      expect(byId[ids[key]!], key).toMatchObject({ guest_email: expect.any(String), pii_redacted_at: null });
    }
    // Already-redacted rows are left alone.
    expect(new Date(byId[ids.alreadyRedacted!]!.pii_redacted_at!).getTime()).toBe(
      alreadyRedactedAt.getTime(),
    );

    const audit = await query<{ entity_id: string; changes: unknown }>(
      sql`select entity_id, changes from audit_logs where organization_id = ${orgId} and action = 'booking.guest_data_redacted'`,
    );
    expect(audit.map((a) => a.entity_id).sort()).toEqual([ids.departedLongAgo, ids.failedLongAgo].sort());
    expect(audit.every((a) => JSON.stringify(a.changes) === '{"trigger":"retention"}')).toBe(true);

    const outbox = await query<{ topic: string; to: string | null; dispatched: boolean }>(
      sql`select topic, payload->>'to' as to, dispatched_at is not null as dispatched from outbox where organization_id = ${orgId} order by id`,
    );
    expect(outbox).toEqual([
      { topic: 'job.enqueue', to: null, dispatched: true },
      { topic: 'email.send', to: 'slow@example.com', dispatched: false },
      { topic: 'job.enqueue', to: null, dispatched: false },
    ]);
    const jobs = await query<{ type: string }>(sql`select type from jobs order by id`);
    expect(jobs.map((j) => j.type)).toEqual(['new.completed', 'new.failed', 'pending']);
    const events = await query<{ event_id: string }>(sql`select event_id from webhook_events`);
    expect(events.map((e) => e.event_id)).toEqual(['evt_new']);
  });

  it('is idempotent: a second run finds nothing to do', async () => {
    expect(await app.container.services.privacy.runRetention()).toEqual({
      bookingsRedacted: 0,
      outboxDeleted: 0,
      undeliveredEmailsDropped: 0,
      jobsDeleted: 0,
      webhookEventsDeleted: 0,
    });
  });

  it('runs as the scheduled privacy.retention job', async () => {
    const late = await seedBooking(app, hotel, {
      email: 'late@example.com',
      arrival: addDays(today, -60),
      departure: addDays(today, -58),
    });
    const handlers = createJobHandlers(app.container);
    await handlers['privacy.retention']!({}, { logger: app.container.logger, attempt: 1 });
    const [row] = await query<{ guest_email: string | null }>(
      sql`select guest_email from bookings where id = ${late.id}`,
    );
    expect(row!.guest_email).toBeNull();
  });
});

describe('outbox delivery scrubbing', () => {
  it('drops a delivered email’s recipient, content and earlier errors', async () => {
    await app.container.db.tenant(orgId, (r) =>
      r.outbox.add('email.send', {
        to: 'guest@example.com',
        template: 'invitation',
        data: {
          organizationName: 'X',
          inviterEmail: 'owner@example.com',
          role: 'viewer',
          link: 'https://x.test/invite/abc',
        },
      }),
    );
    await query(
      sql`update outbox set last_error = 'Rejected guest@example.com' where payload->>'to' = 'guest@example.com'`,
    );
    await app.container.services.outbox.dispatchBatch();
    const rows = await query<{ payload: unknown; last_error: string | null }>(
      sql`select payload, last_error from outbox where organization_id = ${orgId} and topic = 'email.send' and dispatched_at is not null order by id desc limit 1`,
    );
    expect(rows[0]).toEqual({ payload: { scrubbed: true }, last_error: null });
    expect(app.mailer.sent.at(-1)!.to).toBe('guest@example.com');
  });

  it('never stores recipient addresses in delivery errors', async () => {
    const failing = await createTestApp(
      {},
      {
        mailer: {
          send: async (message) => {
            throw new Error(`Email address is not verified: ${message.to}`);
          },
        },
      },
    );
    try {
      const org = await newOrg(failing, 'Failing Mail Hotels');
      await failing.container.db.tenant(org.orgId, (r) =>
        r.outbox.add('email.send', {
          to: 'guest@example.com',
          template: 'invitation',
          data: {
            organizationName: 'X',
            inviterEmail: 'owner@example.com',
            role: 'viewer',
            link: 'https://x.test/invite/abc',
          },
        }),
      );
      await failing.container.services.outbox.dispatchBatch();
      const rows = await failing.container.db.system(
        async ({ tx }) =>
          (await tx.execute(sql`select last_error from outbox where last_error is not null`)).rows as {
            last_error: string;
          }[],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.last_error).toContain('Email address is not verified: [email]');
      expect(rows[0]!.last_error).not.toContain('guest@example.com');
    } finally {
      await failing.close();
    }
  });
});
