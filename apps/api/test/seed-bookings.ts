import { randomUUID } from 'node:crypto';
import type { BookingRow, BookingStatus, OfferQuoteDetails } from '@lodgent/db';
import type { TestApp } from './helpers';

/**
 * Direct seeding of hotels and bookings (no PMS or Stripe round trips) for tests that only need
 * booking rows to exist: guest data export/erasure and retention.
 */

export interface SeededHotel {
  orgId: string;
  propertyId: string;
  propertyName: string;
  roomTypeId: string;
  ratePlanId: string;
}

const eur = (amount: number) => ({ amount, currency: 'EUR' });

const OFFER: OfferQuoteDetails = {
  roomTypeName: 'Classic Double',
  ratePlanName: 'Flexible rate',
  ratePlanDescription: null,
  pmsRatePlanId: 'LIS-FLEX-DBL',
  minGuarantee: 'credit_card',
  accommodation: eur(37_500),
  includedTaxes: eur(3_750),
  extras: [],
  prepayment: eur(0),
  nightly: [
    { date: '2026-11-10', amount: eur(18_750) },
    { date: '2026-11-11', amount: eur(18_750) },
  ],
  cancellation: { code: 'FLEX', name: 'Flexible', description: null, freeUntil: null, fee: eur(0) },
  noShowFee: null,
};

export async function seedHotel(
  app: TestApp,
  orgId: string,
  name = 'Casa Azul Lisboa',
): Promise<SeededHotel> {
  return app.container.db.tenant(orgId, async (r) => {
    const property = await r.properties.create({
      name,
      slug: `test-${randomUUID().slice(0, 8)}`,
      timeZone: 'Europe/Lisbon',
      currency: 'EUR',
    });
    const roomType = await r.roomTypes.insert({ propertyId: property.id, name: 'Classic Double' });
    const ratePlan = await r.ratePlans.upsertByPmsId(property.id, 'LIS-FLEX-DBL', {
      roomTypeId: roomType.id,
      name: 'Flexible rate',
      minGuarantee: 'credit_card',
      paymentMode: 'pay_at_hotel',
    });
    return {
      orgId,
      propertyId: property.id,
      propertyName: property.name,
      roomTypeId: roomType.id,
      ratePlanId: ratePlan.id,
    };
  });
}

export interface BookingSeed {
  email: string | null;
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  specialRequests?: string | null;
  status?: BookingStatus;
  arrival: string;
  departure: string;
  paymentMode?: 'prepaid' | 'pay_at_hotel';
  pmsReservationId?: string | null;
  setupIntentId?: string | null;
  paymentIntentId?: string | null;
}

let counter = 0;

export async function seedBooking(app: TestApp, hotel: SeededHotel, seed: BookingSeed): Promise<BookingRow> {
  counter += 1;
  const paymentMode = seed.paymentMode ?? 'pay_at_hotel';
  return app.container.db.tenant(hotel.orgId, async (r) => {
    const hold = await r.holds.create({
      propertyId: hotel.propertyId,
      roomTypeId: hotel.roomTypeId,
      ratePlanId: hotel.ratePlanId,
      channel: 'mcp',
      clientName: 'claude-ai',
      arrival: seed.arrival,
      departure: seed.departure,
      adults: 2,
      currency: 'EUR',
      totalAmount: 41_250,
      dueNowAmount: paymentMode === 'prepaid' ? 41_250 : 0,
      paymentMode,
      feeBps: 200,
      feeAmount: 825,
      offer: OFFER,
      status: seed.status === 'confirmed' ? 'confirmed' : 'active',
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
    return r.bookings.create({
      propertyId: hotel.propertyId,
      holdId: hold.id,
      reference: `LG-T${String(counter).padStart(4, '0')}${randomUUID().slice(0, 4).toUpperCase()}`,
      status: seed.status ?? 'confirmed',
      paymentMode,
      currency: 'EUR',
      totalAmount: 41_250,
      dueNowAmount: paymentMode === 'prepaid' ? 41_250 : 0,
      feeBps: 200,
      feeAmount: 825,
      arrival: seed.arrival,
      departure: seed.departure,
      adults: 2,
      roomTypeId: hotel.roomTypeId,
      ratePlanId: hotel.ratePlanId,
      channel: 'mcp',
      paymentAccountId: 'acct_test_hotel',
      guestFirstName: seed.firstName ?? 'Ana',
      guestLastName: seed.lastName ?? 'Silva',
      guestEmail: seed.email,
      guestPhone: seed.phone === undefined ? '+351 912 000 000' : seed.phone,
      specialRequests:
        seed.specialRequests === undefined ? 'Late arrival, around 23:00' : seed.specialRequests,
      termsAcceptedAt: new Date(),
      pmsReservationId: seed.pmsReservationId ?? null,
      confirmationNumber: seed.pmsReservationId ? `${seed.pmsReservationId}-1` : null,
      setupIntentId: seed.setupIntentId ?? null,
      paymentIntentId: seed.paymentIntentId ?? null,
      confirmedAt: seed.status === undefined || seed.status === 'confirmed' ? new Date() : null,
    });
  });
}

/** Adds an existing user (by bearer token) to the org with a role. */
export async function addMember(
  app: TestApp,
  orgId: string,
  role: 'owner' | 'admin' | 'viewer',
): Promise<{ token: string; email: string }> {
  const user = await app.login();
  const me = await app.call('GET', '/v1/me', { token: user.token });
  await app.container.db.tenant(orgId, (r) => r.members.add(me.body.user.id as string, role));
  return user;
}
