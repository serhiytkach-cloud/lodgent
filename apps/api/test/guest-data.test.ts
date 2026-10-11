import { GUEST_DATA_REQUESTS_PER_HOUR } from '@lodgent/application';
import { sql } from '@lodgent/db';
import { addDays, localDateAt } from '@lodgent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, newOrg, type TestApp } from './helpers';
import { addMember, type SeededHotel, seedBooking, seedHotel } from './seed-bookings';

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON responses.
type Json = any;

let app: TestApp;
let owner: { token: string; orgId: string };
let other: { token: string; orgId: string };
let viewerToken: string;
let adminToken: string;
let hotel: SeededHotel;
let otherHotel: SeededHotel;

const GUEST = 'ana.silva@example.com';
const today = localDateAt(new Date(), 'Europe/Lisbon');
/** Each test uses its own client IP so the per-IP route limit (10/min) never interferes. */
let ipCounter = 0;
const nextIp = () => `10.20.0.${++ipCounter}`;

const exportFor = (orgId: string, token: string, email: unknown, remoteAddress = nextIp()) =>
  app.call('POST', `/v1/orgs/${orgId}/guest-data/export`, { token, body: { email }, remoteAddress });
const eraseFor = (orgId: string, token: string, body: unknown, remoteAddress = nextIp()) =>
  app.call('POST', `/v1/orgs/${orgId}/guest-data/erase`, { token, body, remoteAddress });

async function bookingRow(id: string) {
  const rows = await app.container.db.system(
    async ({ tx }) =>
      (
        await tx.execute(
          sql`select guest_first_name, guest_last_name, guest_email, guest_phone, special_requests, pii_redacted_at, total_amount, reference from bookings where id = ${id}`,
        )
      ).rows,
  );
  return rows[0] as Record<string, unknown>;
}

async function auditRows(orgId: string) {
  return app.container.db.system(
    async ({ tx }) =>
      (
        await tx.execute(
          sql`select action, entity_type, entity_id, changes::text as changes from audit_logs where organization_id = ${orgId} order by created_at`,
        )
      ).rows as { action: string; entity_type: string; entity_id: string | null; changes: string | null }[],
  );
}

beforeAll(async () => {
  app = await createTestApp();
  owner = await newOrg(app, 'Casa Azul Hotels');
  other = await newOrg(app, 'Someone Else Hotels');
  viewerToken = (await addMember(app, owner.orgId, 'viewer')).token;
  adminToken = (await addMember(app, owner.orgId, 'admin')).token;
  hotel = await seedHotel(app, owner.orgId, 'Casa Azul Lisboa');
  otherHotel = await seedHotel(app, other.orgId, 'Other Hotel Porto');
});

afterAll(async () => {
  await app.close();
});

describe('guest data export', () => {
  let past: string;
  let upcoming: string;
  let otherGuest: string;
  let otherOrgBooking: string;

  beforeAll(async () => {
    past = (
      await seedBooking(app, hotel, {
        email: GUEST,
        arrival: addDays(today, -20),
        departure: addDays(today, -18),
        pmsReservationId: 'LIS-PAST',
      })
    ).id;
    // Stored with mixed case (rows from before emails were lower-cased) still match.
    upcoming = (
      await seedBooking(app, hotel, {
        email: 'Ana.Silva@Example.com',
        arrival: addDays(today, 10),
        departure: addDays(today, 12),
        pmsReservationId: 'LIS-NEXT',
        setupIntentId: 'seti_test_1',
      })
    ).id;
    otherGuest = (
      await seedBooking(app, hotel, {
        email: 'rui.costa@example.com',
        firstName: 'Rui',
        lastName: 'Costa',
        arrival: addDays(today, 5),
        departure: addDays(today, 6),
      })
    ).id;
    // The same guest at another organization: never visible or touched from this one.
    otherOrgBooking = (
      await seedBooking(app, otherHotel, {
        email: GUEST,
        arrival: addDays(today, 3),
        departure: addDays(today, 4),
      })
    ).id;
  });

  it("returns the guest's bookings in this organization, matching the email case-insensitively", async () => {
    const res = await exportFor(owner.orgId, owner.token, '  ANA.Silva@example.COM ');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.subject).toEqual({ email: GUEST, ref: expect.stringMatching(/^g_[0-9a-f]{32}$/) });
    expect(res.body.organization).toEqual({ id: owner.orgId, name: 'Casa Azul Hotels' });
    expect(res.body.bookings.map((b: Json) => b.id).sort()).toEqual([past, upcoming].sort());
    const first = res.body.bookings.find((b: Json) => b.id === past);
    expect(first).toMatchObject({
      status: 'confirmed',
      property: { id: hotel.propertyId, name: 'Casa Azul Lisboa' },
      stay: {
        arrival: addDays(today, -20),
        departure: addDays(today, -18),
        nights: 2,
        adults: 2,
        childrenAges: [],
        roomType: 'Classic Double',
        ratePlan: 'Flexible rate',
        timeZone: 'Europe/Lisbon',
      },
      price: {
        currency: 'EUR',
        total: { amount: 41_250, currency: 'EUR' },
        paymentMode: 'pay_at_hotel',
      },
      guest: {
        firstName: 'Ana',
        lastName: 'Silva',
        email: GUEST,
        phone: '+351 912 000 000',
        specialRequests: 'Late arrival, around 23:00',
      },
      confirmationNumber: 'LIS-PAST-1',
      bookedVia: 'mcp',
      termsAcceptedAt: expect.any(String),
      createdAt: expect.any(String),
    });
    expect(res.body.notes.join(' ')).toContain('Apaleo');
    expect(JSON.stringify(res.body)).not.toContain('rui.costa');
    expect(res.body.bookings.map((b: Json) => b.id)).not.toContain(otherOrgBooking);
    expect(res.body.bookings.map((b: Json) => b.id)).not.toContain(otherGuest);
  });

  it('gives each organization its own pseudonymous guest reference', async () => {
    const mine = await exportFor(owner.orgId, owner.token, GUEST);
    const theirs = await exportFor(other.orgId, other.token, GUEST);
    expect(theirs.status).toBe(200);
    expect(theirs.body.bookings.map((b: Json) => b.id)).toEqual([otherOrgBooking]);
    expect(theirs.body.subject.ref).not.toBe(mine.body.subject.ref);
    // Stable within an organization.
    expect((await exportFor(owner.orgId, adminToken, GUEST)).body.subject.ref).toBe(mine.body.subject.ref);
  });

  it('returns an empty export for an unknown guest', async () => {
    const res = await exportFor(owner.orgId, owner.token, 'nobody@example.com');
    expect(res.status).toBe(200);
    expect(res.body.bookings).toEqual([]);
  });

  it('requires guest-data.manage, hides other organizations and validates the email', async () => {
    expect((await exportFor(owner.orgId, viewerToken, GUEST)).status).toBe(403);
    expect((await eraseFor(owner.orgId, viewerToken, { email: GUEST })).status).toBe(403);
    expect((await exportFor(owner.orgId, other.token, GUEST)).status).toBe(404);
    expect((await eraseFor(owner.orgId, other.token, { email: GUEST })).status).toBe(404);
    expect((await exportFor(owner.orgId, '', GUEST)).status).toBe(401);
    const invalid = await exportFor(owner.orgId, owner.token, 'not an email');
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details.issues[0].path).toBe('body.email');
    expect((await eraseFor(owner.orgId, owner.token, { email: GUEST, reason: 'x'.repeat(201) })).status).toBe(
      400,
    );
    // Nothing was erased by the rejected calls.
    expect((await bookingRow(past)).guest_email).toBe(GUEST);
  });

  it('audit-logs each export with a pseudonymous reference, never the email', async () => {
    const res = await exportFor(owner.orgId, owner.token, GUEST);
    const rows = (await auditRows(owner.orgId)).filter((r) => r.action === 'guest_data.exported');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.at(-1)).toMatchObject({ entity_type: 'guest', entity_id: res.body.subject.ref });
    for (const row of await auditRows(owner.orgId)) {
      expect(JSON.stringify(row).toLowerCase()).not.toContain('ana.silva');
      expect(JSON.stringify(row).toLowerCase()).not.toContain('example.com');
    }
    const log = await app.call('GET', `/v1/orgs/${owner.orgId}/audit-log`, { token: owner.token });
    expect(log.status).toBe(200);
    expect(JSON.stringify(log.body).toLowerCase()).not.toContain('ana.silva');
  });
});

describe('guest data erasure', () => {
  const EVA = 'eva.lopes@example.com';
  let hotelEva: SeededHotel;
  let departed: string;
  let upcoming: string;
  let inCheckout: string;
  let bystander: string;
  let otherOrgEva: string;

  beforeAll(async () => {
    hotelEva = await seedHotel(app, owner.orgId, 'Casa Azul Sintra');
    departed = (
      await seedBooking(app, hotelEva, {
        email: EVA,
        firstName: 'Eva',
        lastName: 'Lopes',
        arrival: addDays(today, -40),
        departure: addDays(today, -38),
        pmsReservationId: 'SIN-OLD',
        paymentMode: 'prepaid',
        paymentIntentId: 'pi_test_1',
      })
    ).id;
    upcoming = (
      await seedBooking(app, hotelEva, {
        email: EVA,
        firstName: 'Eva',
        lastName: 'Lopes',
        arrival: addDays(today, 7),
        departure: addDays(today, 9),
        pmsReservationId: 'SIN-NEXT',
        setupIntentId: 'seti_test_2',
      })
    ).id;
    inCheckout = (
      await seedBooking(app, hotelEva, {
        email: EVA,
        firstName: 'Eva',
        lastName: 'Lopes',
        status: 'pending_payment',
        arrival: addDays(today, 20),
        departure: addDays(today, 21),
      })
    ).id;
    bystander = (
      await seedBooking(app, hotelEva, {
        email: 'joao.pereira@example.com',
        firstName: 'Joao',
        lastName: 'Pereira',
        arrival: addDays(today, 7),
        departure: addDays(today, 9),
      })
    ).id;
    otherOrgEva = (
      await seedBooking(app, otherHotel, {
        email: EVA,
        firstName: 'Eva',
        lastName: 'Lopes',
        arrival: addDays(today, 7),
        departure: addDays(today, 9),
      })
    ).id;
    // An unsent confirmation to Eva in each org, and a staff invitation to the same address.
    for (const orgId of [owner.orgId, other.orgId]) {
      await app.container.db.tenant(orgId, (r) =>
        r.outbox.add(
          'email.send',
          { to: EVA, template: 'booking-confirmation', data: { guestName: 'Eva Lopes' } },
          { availableAt: new Date(Date.now() + 3_600_000) },
        ),
      );
    }
    await app.container.db.tenant(owner.orgId, (r) =>
      r.outbox.add(
        'email.send',
        { to: EVA, template: 'invitation', data: {} },
        { availableAt: new Date(Date.now() + 3_600_000) },
      ),
    );
  });

  async function pendingEmailsTo(email: string) {
    return app.container.db.system(
      async ({ tx }) =>
        (
          await tx.execute(
            sql`select organization_id, payload->>'template' as template from outbox where payload->>'to' = ${email} and dispatched_at is null order by id`,
          )
        ).rows as { organization_id: string; template: string }[],
    );
  }

  it("erases the guest's details on their bookings in this organization only", async () => {
    const res = await eraseFor(owner.orgId, adminToken, {
      email: 'EVA.Lopes@example.com',
      reason: 'Guest asked by email (eva.lopes@example.com, +351 912 345 678)',
    });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      subject: { ref: expect.stringMatching(/^g_[0-9a-f]{32}$/) },
      matched: 3,
      erased: 2,
      deferred: 1,
      pendingEmailsDropped: 1,
    });
    const results = Object.fromEntries(res.body.bookings.map((b: Json) => [b.id, b.result]));
    expect(results).toEqual({ [departed]: 'erased', [upcoming]: 'erased', [inCheckout]: 'deferred' });
    const warnings = res.body.warnings.join('\n');
    expect(warnings).toMatch(/1 erased booking is upcoming or in progress/);
    expect(warnings).toContain('PMS');
    expect(warnings).toContain('Stripe');
    expect(warnings).toMatch(/1 booking is still in checkout/);

    for (const id of [departed, upcoming]) {
      expect(await bookingRow(id)).toMatchObject({
        guest_first_name: null,
        guest_last_name: null,
        guest_email: null,
        guest_phone: null,
        special_requests: null,
        pii_redacted_at: expect.anything(),
        total_amount: '41250',
      });
    }
    // The checkout still running keeps the details it needs; others are untouched.
    expect(await bookingRow(inCheckout)).toMatchObject({ guest_email: EVA, pii_redacted_at: null });
    expect(await bookingRow(bystander)).toMatchObject({
      guest_email: 'joao.pereira@example.com',
      pii_redacted_at: null,
    });
    expect(await bookingRow(otherOrgEva)).toMatchObject({ guest_email: EVA, pii_redacted_at: null });

    // Eva's unsent confirmation in this org is gone; the other org's and the staff invitation stay.
    const pending = await pendingEmailsTo(EVA);
    expect(pending).toEqual(
      expect.arrayContaining([
        { organization_id: other.orgId, template: 'booking-confirmation' },
        { organization_id: owner.orgId, template: 'invitation' },
      ]),
    );
    expect(pending).toHaveLength(2);
  });

  it('shows erased bookings as erased in the dashboard', async () => {
    const detail = await app.call('GET', `/v1/orgs/${owner.orgId}/bookings/${upcoming}`, {
      token: owner.token,
    });
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      guestName: null,
      guestEmail: null,
      guestPhone: null,
      specialRequests: null,
      piiRedactedAt: expect.any(String),
    });
    expect(detail.body.timeline.map((t: Json) => t.label)).toContain('Guest data erased');
  });

  it('audit-logs the erasure per booking and in summary, without the email', async () => {
    const rows = await auditRows(owner.orgId);
    const summary = rows.filter((r) => r.action === 'guest_data.erased');
    expect(summary).toHaveLength(1);
    expect(summary[0]!.entity_type).toBe('guest');
    expect(summary[0]!.entity_id).toMatch(/^g_[0-9a-f]{32}$/);
    const changes = JSON.parse(summary[0]!.changes!);
    expect(changes).toMatchObject({ matched: 3, deferred: [expect.any(String)], pendingEmailsDropped: 1 });
    expect(changes.erased).toHaveLength(2);
    // The free-text reason is kept, with contact details masked.
    expect(changes.reason).toContain('Guest asked by email');
    expect(changes.reason).toContain('[email]');
    expect(changes.reason).not.toContain('912');
    const perBooking = rows.filter((r) => r.action === 'booking.guest_data_redacted');
    expect(perBooking.map((r) => r.entity_id).sort()).toEqual([departed, upcoming].sort());
    for (const row of perBooking) {
      expect(JSON.parse(row.changes!)).toEqual({
        trigger: 'erasure_request',
        subject: summary[0]!.entity_id,
      });
    }
    for (const row of rows) expect(JSON.stringify(row).toLowerCase()).not.toContain('eva.lopes');
  });

  it('is idempotent and finishes deferred bookings once checkout is over', async () => {
    const again = await eraseFor(owner.orgId, owner.token, { email: EVA });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ matched: 1, erased: 0, deferred: 1, pendingEmailsDropped: 0 });
    expect(await bookingRow(departed)).toMatchObject({ guest_email: null });

    // The checkout fails (reconciliation closes it); erasing again now covers it.
    await app.container.db.tenant(owner.orgId, (r) => r.bookings.update(inCheckout, { status: 'failed' }));
    const finish = await eraseFor(owner.orgId, owner.token, { email: EVA });
    expect(finish.body).toMatchObject({ matched: 1, erased: 1, deferred: 0, warnings: [] });

    const done = await eraseFor(owner.orgId, owner.token, { email: EVA });
    expect(done.body).toMatchObject({ matched: 0, erased: 0, deferred: 0, bookings: [], warnings: [] });
    // Nothing is left to export.
    expect((await exportFor(owner.orgId, owner.token, EVA)).body.bookings).toEqual([]);
    // Another organization's booking for the same guest is still there.
    expect((await exportFor(other.orgId, other.token, EVA)).body.bookings).toHaveLength(1);
  });
});

describe('guest data request limits', () => {
  it('limits requests per client IP', async () => {
    const ip = '10.30.0.1';
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await exportFor(owner.orgId, owner.token, GUEST, ip)).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Erasure has its own budget.
    expect((await eraseFor(owner.orgId, owner.token, { email: 'x@example.com' }, ip)).status).toBe(200);
  });

  it('caps requests per organization per hour, across clients', async () => {
    const org = await newOrg(app, 'Busy Hotels');
    await app.container.db.tenant(org.orgId, (r) =>
      r.audit.recordMany(
        Array.from({ length: GUEST_DATA_REQUESTS_PER_HOUR }, () => ({
          actorType: 'system' as const,
          actorUserId: null,
          action: 'guest_data.exported',
          entityType: 'guest',
          entityId: null,
        })),
      ),
    );
    const res = await exportFor(org.orgId, org.token, GUEST);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('rate_limited');
    expect((await eraseFor(org.orgId, org.token, { email: GUEST })).status).toBe(429);
  });
});
