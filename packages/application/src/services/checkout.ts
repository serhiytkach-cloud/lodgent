import { randomBytes } from 'node:crypto';
import {
  type Clock,
  ConflictError,
  DomainError,
  describeCancellation,
  type GuaranteeType,
  NotFoundError,
  type PaymentEvent,
  type PaymentProvider,
  type PmsReservation,
  UnprocessableError,
  UpstreamError,
} from '@lodgent/core';
import type { BookingRow, Database, HoldRow, PropertyRow } from '@lodgent/db';
import {
  addDays,
  type CheckoutDto,
  type CheckoutGuestInput,
  formatMoney,
  localDateAt,
  nightsBetween,
  toDisplayMoney,
} from '@lodgent/shared';
import type { Logger } from 'pino';
import { systemActor } from '../context';
import type { Signer } from '../infra/signing';
import type { OfferService } from './offers';
import type { PmsConnectionService } from './pms-connections';

const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** A finalization that hasn't finished after this long is assumed crashed and may be retried. */
const FINALIZE_LEASE_MS = 2 * 60_000;
/** Give up on a reservation the PMS keeps failing to create after this long (and release the payment). */
const MAX_RESERVING_MS = 30 * 60_000;

export function bookingReference(): string {
  const bytes = randomBytes(8);
  return `LG-${Array.from(bytes, (b) => REFERENCE_ALPHABET[b % REFERENCE_ALPHABET.length]).join('')}`;
}

function isPermanentPmsError(error: unknown): boolean {
  if (!(error instanceof UpstreamError)) return false;
  const status = Number(error.details?.status);
  return Number.isFinite(status) && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

interface Loaded {
  orgId: string;
  hold: HoldRow;
  property: PropertyRow;
  booking: BookingRow | null;
  includes: string[];
  policies: { title: string; description: string | null; kind: string }[];
}

/**
 * Hosted guest checkout and booking finalization (ADR 0009).
 *
 * Prepaid: a manual-capture PaymentIntent on the hotel's Stripe account authorizes the full amount
 * with our fee as the application fee. Once authorized we re-verify the offer, create the
 * reservation in the PMS, then capture; if the reservation fails, the authorization is released.
 *
 * Pay at hotel: a SetupIntent saves the guest's card on the hotel's account as the guarantee, then
 * the reservation is created; our fee accrues to the ledger and is invoiced monthly.
 *
 * Finalization is idempotent and safe to run concurrently: the browser, the Stripe webhook and the
 * reconciliation job all call it; a compare-and-set claim lets only one proceed at a time.
 */
export class CheckoutService {
  constructor(
    private readonly deps: {
      db: Database;
      clock: Clock;
      payments: PaymentProvider;
      offers: OfferService;
      connections: PmsConnectionService;
      signer: Signer;
      logger: Logger;
      webBaseUrl: string;
      simulatorUrl: string | null;
      piiRetentionDays: number;
    },
  ) {}

  // ---- loading -----------------------------------------------------------------------------

  private holdIdFrom(token: string): string {
    const payload = this.deps.signer.verify<{ h?: unknown }>('checkout', token, this.deps.clock.now());
    if (typeof payload?.h !== 'string') throw new NotFoundError('Checkout');
    return payload.h;
  }

  private async load(token: string): Promise<Loaded> {
    const holdId = this.holdIdFrom(token);
    const owner = await this.deps.db.system(({ holds }) => holds.owner(holdId));
    if (!owner) throw new NotFoundError('Checkout');
    return this.loadByHold(owner.organizationId, holdId);
  }

  private async loadByHold(orgId: string, holdId: string): Promise<Loaded> {
    return this.deps.db.tenant(orgId, async (r) => {
      const hold = await r.holds.get(holdId);
      if (!hold) throw new NotFoundError('Checkout');
      const property = await r.properties.get(hold.propertyId);
      if (!property) throw new NotFoundError('Checkout');
      const ratePlan = await r.ratePlans.get(hold.ratePlanId);
      const policies = await r.policies.listForProperty(hold.propertyId);
      return {
        orgId,
        hold,
        property,
        booking: (await r.bookings.byHold(holdId)) ?? null,
        includes: ratePlan?.includedServices.map((s) => s.name) ?? [],
        policies: policies
          .filter((p) => p.kind !== 'cancellation' || p.id === ratePlan?.cancellationPolicyId)
          .map((p) => ({ title: p.title, description: p.description, kind: p.kind })),
      };
    });
  }

  // ---- guest-facing ------------------------------------------------------------------------

  async view(token: string): Promise<CheckoutDto> {
    return this.toDto(await this.load(token));
  }

  /** Records the guest's details and opens the payment (or card setup) on the hotel's account. */
  async start(token: string, guest: CheckoutGuestInput): Promise<CheckoutDto> {
    const { db, clock, payments } = this.deps;
    const loaded = await this.load(token);
    const { orgId, hold, property } = loaded;
    const now = clock.now();
    if (loaded.booking && loaded.booking.status !== 'pending_payment') return this.toDto(loaded);
    if (hold.status !== 'active' || hold.expiresAt <= now) {
      throw new ConflictError(
        'hold_expired',
        'This reservation hold has expired. Ask your assistant for a new offer.',
      );
    }

    const booking = await db.tenant(orgId, async (r) => {
      const existing = await r.bookings.byHold(hold.id);
      const guestFields = {
        guestFirstName: guest.firstName,
        guestLastName: guest.lastName,
        guestEmail: guest.email.toLowerCase(),
        guestPhone: guest.phone,
        specialRequests: guest.specialRequests,
        termsAcceptedAt: now,
      };
      if (existing) return (await r.bookings.update(existing.id, guestFields))!;
      const account = await r.paymentAccount.get();
      if (!account?.chargesEnabled) {
        throw new UnprocessableError(
          'payments_unavailable',
          `${property.name} can't take online bookings right now. Please contact the hotel directly.`,
        );
      }
      return r.bookings.create({
        propertyId: hold.propertyId,
        holdId: hold.id,
        reference: bookingReference(),
        status: 'pending_payment',
        paymentMode: hold.paymentMode,
        currency: hold.currency,
        totalAmount: hold.totalAmount,
        dueNowAmount: hold.dueNowAmount,
        feeBps: hold.feeBps,
        feeAmount: hold.feeAmount,
        arrival: hold.arrival,
        departure: hold.departure,
        adults: hold.adults,
        childrenAges: hold.childrenAges,
        roomTypeId: hold.roomTypeId,
        ratePlanId: hold.ratePlanId,
        agentClientId: hold.agentClientId,
        channel: hold.channel,
        paymentAccountId: account.accountId,
        ...guestFields,
      });
    });

    if (!booking.paymentIntentId && !booking.setupIntentId) {
      const metadata = { bookingId: booking.id, orgId, holdId: hold.id, reference: booking.reference };
      const description = `${property.name}: ${hold.offer.roomTypeName}, ${hold.arrival} to ${hold.departure} (${booking.reference})`;
      if (hold.paymentMode === 'prepaid') {
        const pi = await payments.createPaymentIntent({
          accountId: booking.paymentAccountId,
          amount: { amount: hold.dueNowAmount, currency: hold.currency },
          applicationFee: { amount: Math.min(hold.feeAmount, hold.dueNowAmount), currency: hold.currency },
          description,
          statementDescriptorSuffix: property.name.replace(/[^A-Za-z0-9 ]/g, '').slice(0, 22) || null,
          receiptEmail: booking.guestEmail,
          metadata,
          idempotencyKey: `pi:${booking.id}`,
        });
        await db.tenant(orgId, (r) =>
          r.bookings.update(booking.id, { paymentIntentId: pi.id, paymentStatus: pi.status }),
        );
      } else {
        const si = await payments.createSetupIntent({
          accountId: booking.paymentAccountId,
          customer: { email: booking.guestEmail!, name: `${guest.firstName} ${guest.lastName}` },
          description: `Guarantee for ${description}`,
          metadata,
          idempotencyKey: `si:${booking.id}`,
        });
        await db.tenant(orgId, (r) =>
          r.bookings.update(booking.id, { setupIntentId: si.id, paymentStatus: si.status }),
        );
      }
    }
    return this.view(token);
  }

  /** Called by the checkout page after Stripe.js reports success; the webhook does the same. */
  async complete(token: string): Promise<CheckoutDto> {
    const loaded = await this.load(token);
    if (!loaded.booking) throw new ConflictError('not_started', 'Enter your details first.');
    await this.finalize(loaded.orgId, loaded.booking.id);
    return this.view(token);
  }

  // ---- finalization ------------------------------------------------------------------------

  /** Moves a paid (or card-guaranteed) booking to a confirmed reservation. Idempotent. */
  async finalize(orgId: string, bookingId: string): Promise<BookingRow> {
    const { db, clock, payments, logger } = this.deps;
    const current = await db.tenant(orgId, (r) => r.bookings.get(bookingId));
    if (!current) throw new NotFoundError('Booking');
    if (current.status === 'confirmed' || current.status === 'failed' || current.status === 'cancelled') {
      return current;
    }

    // 1. Is the money (or the guarantee) there?
    const ready = await this.paymentReady(current);
    if (ready === 'canceled')
      return this.fail(orgId, current, 'The payment was cancelled.', { releasePayment: false });
    if (ready === 'not_ready') return current;

    // 2. Claim it (one finalizer at a time; a stalled claim expires).
    const booking = await db.tenant(orgId, (r) =>
      r.bookings.claim(bookingId, clock.now(), FINALIZE_LEASE_MS),
    );
    if (!booking) return (await db.tenant(orgId, (r) => r.bookings.get(bookingId)))!;
    const { hold, property } = await this.loadByHold(orgId, booking.holdId);
    await db.tenant(orgId, (r) => r.holds.setStatus(hold.id, 'processing'));

    let pmsReservation: Pick<
      PmsReservation,
      'pmsBookingId' | 'pmsReservationId' | 'confirmationNumber'
    > | null = booking.pmsReservationId
      ? {
          pmsBookingId: booking.pmsBookingId ?? '',
          pmsReservationId: booking.pmsReservationId,
          confirmationNumber: booking.confirmationNumber ?? booking.pmsReservationId,
        }
      : null;

    if (!pmsReservation) {
      // 3. Re-verify the offer: same room and rate still available at the same all-in price.
      const verdict = await this.reverify(hold).catch((error: unknown) => {
        logger.warn({ err: error, bookingId }, 'offer re-verification failed');
        return {
          ok: false as const,
          transient: true,
          reason: 'We could not reach the hotel to confirm availability.',
        };
      });
      if (!verdict.ok) {
        if (verdict.transient && clock.now().getTime() - booking.createdAt.getTime() < MAX_RESERVING_MS)
          return booking;
        return this.fail(orgId, booking, verdict.reason, { releasePayment: true });
      }

      // 4. Create the reservation in the PMS (idempotent on the booking id).
      try {
        const client = await this.deps.connections.clientFor(orgId);
        const ratePlan = await db.tenant(orgId, (r) => r.ratePlans.get(hold.ratePlanId));
        const guarantee: GuaranteeType =
          booking.paymentMode === 'prepaid'
            ? 'prepayment'
            : ratePlan?.minGuarantee === 'credit_card'
              ? 'credit_card'
              : 'none';
        const paymentNote =
          booking.paymentMode === 'prepaid'
            ? `Prepaid via Stripe (PaymentIntent ${booking.paymentIntentId}, ${formatMoney({ amount: booking.dueNowAmount, currency: booking.currency })}).`
            : `Pay at hotel. Card on file in your Stripe account (SetupIntent ${booking.setupIntentId}).`;
        const created = await client.createReservation({
          pmsPropertyId: property.pmsPropertyId!,
          pmsRatePlanId: hold.offer.pmsRatePlanId,
          arrival: hold.arrival,
          departure: hold.departure,
          adults: hold.adults,
          childrenAges: hold.childrenAges,
          guest: {
            firstName: booking.guestFirstName ?? '',
            lastName: booking.guestLastName ?? '',
            email: booking.guestEmail ?? '',
            phone: booking.guestPhone,
          },
          specialRequests: booking.specialRequests,
          nightly: hold.offer.nightly.map((n) => ({ amount: n.amount })),
          guarantee,
          externalCode: booking.reference,
          comment: `Booked by an AI agent via Lodgent (${booking.channel}). ${paymentNote} Lodgent ref ${booking.reference}.`,
          idempotencyKey: `booking:${booking.id}`,
        });
        pmsReservation = created;
        await db.tenant(orgId, (r) =>
          r.bookings.update(booking.id, {
            pmsBookingId: created.pmsBookingId,
            pmsReservationId: created.pmsReservationId,
            confirmationNumber: created.confirmationNumber,
            pmsStatus: created.status,
          }),
        );
      } catch (error) {
        logger.warn({ err: error, bookingId }, 'PMS reservation failed');
        const giveUp =
          isPermanentPmsError(error) ||
          clock.now().getTime() - booking.createdAt.getTime() >= MAX_RESERVING_MS;
        if (!giveUp) return booking; // the reconciliation job retries with the same idempotency key
        return this.fail(orgId, booking, 'The hotel could not confirm this reservation.', {
          releasePayment: true,
        });
      }
    }

    // 5. Take the money (prepaid). The reservation exists, so a failure here is retried, not undone.
    let paymentStatus = booking.paymentMode === 'prepaid' ? 'requires_capture' : 'setup_succeeded';
    if (booking.paymentMode === 'prepaid' && booking.paymentIntentId) {
      try {
        const pi = await payments.capturePaymentIntent(
          booking.paymentAccountId,
          booking.paymentIntentId,
          `capture:${booking.id}`,
        );
        paymentStatus = pi.status;
      } catch (error) {
        const pi = await payments
          .getPaymentIntent(booking.paymentAccountId, booking.paymentIntentId)
          .catch(() => null);
        if (pi?.status === 'succeeded') {
          paymentStatus = 'succeeded';
        } else if (pi && pi.status !== 'requires_capture') {
          // The authorization is gone (expired or cancelled): undo the reservation.
          logger.error(
            { err: error, bookingId, status: pi.status },
            'capture impossible; cancelling reservation',
          );
          await this.cancelPmsReservation(orgId, pmsReservation.pmsReservationId);
          return this.fail(orgId, booking, 'The payment could not be completed.', { releasePayment: false });
        } else {
          logger.warn({ err: error, bookingId }, 'capture failed; will retry');
          return booking;
        }
      }
      // 6. Record the payment on the guest's folio in the PMS (best effort; retried by a job).
      await this.recordFolioPayment(orgId, booking, pmsReservation.pmsReservationId);
    }

    // 7. Confirm.
    const now = clock.now();
    const confirmed = await db.tenant(orgId, async (r) => {
      const row = await r.bookings.update(booking.id, {
        status: 'confirmed',
        statusReason: null,
        paymentStatus,
        confirmedAt: now,
      });
      await r.holds.setStatus(hold.id, 'confirmed');
      await r.fees.record({
        propertyId: booking.propertyId,
        bookingId: booking.id,
        collection: booking.paymentMode === 'prepaid' ? 'application_fee' : 'invoice',
        status: booking.paymentMode === 'prepaid' ? 'collected' : 'pending',
        feeBps: booking.feeBps,
        bookingTotalAmount: booking.totalAmount,
        amount:
          booking.paymentMode === 'prepaid'
            ? Math.min(booking.feeAmount, booking.dueNowAmount)
            : booking.feeAmount,
        currency: booking.currency,
        occurredAt: now,
      });
      await r.audit.record({
        ...systemActor,
        action: 'booking.confirmed',
        entityType: 'booking',
        entityId: booking.id,
        changes: { reference: booking.reference, confirmationNumber: pmsReservation!.confirmationNumber },
      });
      await r.outbox.add('email.send', {
        to: booking.guestEmail,
        template: 'booking-confirmation',
        data: this.confirmationEmail(booking, hold, property, pmsReservation!.confirmationNumber),
      });
      return row!;
    });
    logger.info({ bookingId, reference: booking.reference }, 'booking confirmed');
    return confirmed;
  }

  private async paymentReady(b: BookingRow): Promise<'ready' | 'not_ready' | 'canceled'> {
    const { payments } = this.deps;
    if (b.status === 'reserving') return 'ready';
    if (b.paymentMode === 'prepaid') {
      if (!b.paymentIntentId) return 'not_ready';
      const pi = await payments.getPaymentIntent(b.paymentAccountId, b.paymentIntentId);
      if (pi.status === 'requires_capture' || pi.status === 'succeeded') return 'ready';
      return pi.status === 'canceled' ? 'canceled' : 'not_ready';
    }
    if (!b.setupIntentId) return 'not_ready';
    const si = await payments.getSetupIntent(b.paymentAccountId, b.setupIntentId);
    if (si.status === 'succeeded') return 'ready';
    return si.status === 'canceled' ? 'canceled' : 'not_ready';
  }

  private async reverify(
    hold: HoldRow,
  ): Promise<{ ok: true } | { ok: false; transient: boolean; reason: string }> {
    const fresh = await this.deps.offers.search(
      {
        propertyId: hold.propertyId,
        checkIn: hold.arrival,
        checkOut: hold.departure,
        adults: hold.adults,
        childrenAges: hold.childrenAges,
      },
      { allowUnpublished: true },
    );
    const match = fresh.quotes.find(
      (q) => q.ratePlanId === hold.ratePlanId && q.roomTypeId === hold.roomTypeId,
    );
    if (!match)
      return { ok: false, transient: false, reason: 'The room is no longer available for these dates.' };
    if (match.totalAmount !== hold.totalAmount || match.currency !== hold.currency) {
      return {
        ok: false,
        transient: false,
        reason: `The price changed to ${formatMoney({ amount: match.totalAmount, currency: match.currency })} before the booking completed.`,
      };
    }
    return { ok: true };
  }

  private async fail(
    orgId: string,
    booking: BookingRow,
    reason: string,
    options: { releasePayment: boolean },
  ): Promise<BookingRow> {
    const { db, payments, logger } = this.deps;
    if (options.releasePayment && booking.paymentIntentId) {
      try {
        await payments.cancelPaymentIntent(
          booking.paymentAccountId,
          booking.paymentIntentId,
          `cancel:${booking.id}`,
        );
      } catch (error) {
        // Already cancelled or never authorized; anything else is logged for follow-up.
        logger.warn({ err: error, bookingId: booking.id }, 'could not release payment authorization');
      }
    }
    return db.tenant(orgId, async (r) => {
      const row = await r.bookings.update(booking.id, {
        status: 'failed',
        statusReason: reason,
        paymentStatus: booking.paymentIntentId && options.releasePayment ? 'canceled' : booking.paymentStatus,
      });
      await r.holds.setStatus(booking.holdId, 'failed', reason);
      await r.audit.record({
        ...systemActor,
        action: 'booking.failed',
        entityType: 'booking',
        entityId: booking.id,
        changes: { reason },
      });
      return row!;
    });
  }

  private async cancelPmsReservation(orgId: string, pmsReservationId: string): Promise<void> {
    try {
      const client = await this.deps.connections.clientFor(orgId);
      await client.cancelReservation(pmsReservationId);
    } catch (error) {
      this.deps.logger.error(
        { err: error, pmsReservationId },
        'could not cancel PMS reservation; needs manual follow-up',
      );
    }
  }

  private async recordFolioPayment(
    orgId: string,
    booking: BookingRow,
    pmsReservationId: string,
  ): Promise<void> {
    if (booking.folioPaymentRecordedAt || !booking.paymentIntentId) return;
    try {
      const client = await this.deps.connections.clientFor(orgId);
      await client.recordPayment({
        pmsReservationId,
        amount: { amount: booking.dueNowAmount, currency: booking.currency },
        reference: booking.paymentIntentId,
        idempotencyKey: `folio:${booking.id}`,
      });
      await this.deps.db.tenant(orgId, (r) =>
        r.bookings.update(booking.id, { folioPaymentRecordedAt: this.deps.clock.now() }),
      );
    } catch (error) {
      this.deps.logger.warn({ err: error, bookingId: booking.id }, 'folio payment not recorded; will retry');
      await this.deps.db.tenant(orgId, (r) =>
        r.outbox.add('job.enqueue', {
          type: 'booking.record-folio-payment',
          payload: { orgId, bookingId: booking.id },
          delaySeconds: 300,
        }),
      );
    }
  }

  /** Job: retries recording a captured payment on the PMS folio. */
  async retryFolioPayment(orgId: string, bookingId: string): Promise<void> {
    const booking = await this.deps.db.tenant(orgId, (r) => r.bookings.get(bookingId));
    if (!booking?.pmsReservationId || booking.status !== 'confirmed') return;
    await this.recordFolioPayment(orgId, booking, booking.pmsReservationId);
  }

  // ---- webhooks and jobs -------------------------------------------------------------------

  /** Provider webhook: schedule finalization for the booking the intent belongs to. */
  async handlePaymentEvent(event: PaymentEvent): Promise<{ orgId: string; bookingId: string } | null> {
    if (event.type !== 'payment_intent.updated' && event.type !== 'setup_intent.updated') return null;
    const bookingId = event.metadata.bookingId;
    if (!bookingId) return null;
    const owner = await this.deps.db.system(({ bookings }) => bookings.owner(bookingId));
    if (!owner) return null;
    return { orgId: owner.organizationId, bookingId };
  }

  /** Job: finalize stalled bookings and release payments for checkouts that ran out of time. */
  async reconcile(): Promise<{ finalized: number; expired: number }> {
    const { db, clock, payments, logger } = this.deps;
    const stuck = await db.system(({ bookings }) =>
      bookings.stuck(new Date(clock.now().getTime() - FINALIZE_LEASE_MS)),
    );
    let finalized = 0;
    let expired = 0;
    for (const { organizationId, bookingId } of stuck) {
      try {
        const before = await db.tenant(organizationId, (r) => r.bookings.get(bookingId));
        const after = await this.finalize(organizationId, bookingId);
        if (after.status === 'confirmed' && before?.status !== 'confirmed') finalized++;
        if (after.status !== 'pending_payment') continue;
        // Never paid, and the hold is long gone: release whatever is open and close it.
        const hold = await db.tenant(organizationId, (r) => r.holds.get(after.holdId));
        if (hold && hold.expiresAt.getTime() < clock.now().getTime() - 15 * 60_000) {
          if (after.paymentIntentId) {
            await payments
              .cancelPaymentIntent(after.paymentAccountId, after.paymentIntentId, `cancel:${after.id}`)
              .catch(() => undefined);
          }
          await db.tenant(organizationId, async (r) => {
            await r.bookings.update(after.id, {
              status: 'failed',
              statusReason: 'Checkout was not completed in time.',
            });
            await r.holds.setStatus(after.holdId, 'expired', 'Checkout not completed in time');
          });
          expired++;
        }
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        logger.warn({ err: error, bookingId }, 'reconciliation step failed');
      }
    }
    return { finalized, expired };
  }

  /** PMS webhook job: mirror reservation status changes made at the hotel. */
  async applyReservationChange(
    orgId: string,
    pmsReservationId: string,
    reservation: PmsReservation | null,
  ): Promise<void> {
    const { db, clock } = this.deps;
    await db.tenant(orgId, async (r) => {
      const booking = await r.bookings.byPmsReservation(pmsReservationId);
      if (!booking) return;
      const status = reservation?.status ?? 'cancelled';
      if (status === booking.pmsStatus) return;
      await r.bookings.update(booking.id, {
        pmsStatus: status,
        ...(status === 'cancelled' && booking.status !== 'cancelled'
          ? { status: 'cancelled' as const, cancelledAt: clock.now() }
          : {}),
      });
      if (status === 'cancelled') {
        const fee = await r.fees.forBooking(booking.id);
        // Invoiced fees on cancelled stays are waived; collected application fees stay (refunds are the hotel's call).
        if (fee?.status === 'pending') await r.fees.setStatus(booking.id, 'void');
      }
      await r.audit.record({
        ...systemActor,
        action: 'booking.pms_status_changed',
        entityType: 'booking',
        entityId: booking.id,
        changes: { from: booking.pmsStatus, to: status },
      });
    });
  }

  /** Retention job: erase guest details some time after departure. */
  async redactExpiredGuestData(): Promise<number> {
    const { db, clock } = this.deps;
    const cutoff = addDays(localDateAt(clock.now(), 'UTC'), -this.deps.piiRetentionDays);
    const due = await db.system(({ bookings }) => bookings.piiExpired(cutoff));
    for (const { organizationId, bookingId } of due) {
      await db.tenant(organizationId, async (r) => {
        await r.bookings.update(bookingId, {
          guestFirstName: null,
          guestLastName: null,
          guestEmail: null,
          guestPhone: null,
          specialRequests: null,
          piiRedactedAt: clock.now(),
        });
        await r.audit.record({
          ...systemActor,
          action: 'booking.guest_data_redacted',
          entityType: 'booking',
          entityId: bookingId,
        });
      });
    }
    return due.length;
  }

  // ---- presentation ------------------------------------------------------------------------

  private cancellationText(hold: HoldRow, property: PropertyRow): string {
    const freeUntil = hold.offer.cancellation.freeUntil ? new Date(hold.offer.cancellation.freeUntil) : null;
    return describeCancellation(
      {
        name: hold.offer.cancellation.name,
        freeUntil,
        fee: hold.offer.cancellation.fee,
        stayPrice: hold.offer.accommodation,
      },
      property.timeZone,
      this.deps.clock.now(),
    );
  }

  private confirmationEmail(
    booking: BookingRow,
    hold: HoldRow,
    property: PropertyRow,
    confirmationNumber: string,
  ) {
    const total = formatMoney({ amount: booking.totalAmount, currency: booking.currency });
    const due = formatMoney({ amount: booking.dueNowAmount, currency: booking.currency });
    const guests = `${booking.adults} adult${booking.adults === 1 ? '' : 's'}${
      booking.childrenAges.length > 0
        ? `, ${booking.childrenAges.length} child${booking.childrenAges.length === 1 ? '' : 'ren'}`
        : ''
    }`;
    return {
      hotelName: property.name,
      hotelAddress:
        [property.addressLine1, property.postalCode, property.city].filter(Boolean).join(', ') || null,
      hotelEmail: property.email,
      hotelPhone: property.phone,
      accentColor: property.brandColor,
      guestName: `${booking.guestFirstName ?? ''} ${booking.guestLastName ?? ''}`.trim(),
      reference: booking.reference,
      confirmationNumber,
      checkIn: booking.arrival,
      checkOut: booking.departure,
      checkInTime: property.checkInTime,
      checkOutTime: property.checkOutTime,
      guests,
      roomType: hold.offer.roomTypeName,
      ratePlan: hold.offer.ratePlanName,
      total,
      payment:
        booking.paymentMode === 'prepaid'
          ? `Paid ${due} by card`
          : `Pay ${total} at the hotel. Your card guarantees the booking.`,
      cancellation: this.cancellationText(hold, property),
      link: `${this.deps.webBaseUrl}/checkout/${this.deps.signer.sign('checkout', { h: hold.id }, 90 * 24 * 3600, this.deps.clock.now())}`,
    };
  }

  private async toDto(loaded: Loaded): Promise<CheckoutDto> {
    const { hold, property, booking } = loaded;
    const now = this.deps.clock.now();
    const money = (amount: number) => toDisplayMoney({ amount, currency: hold.currency });
    const holdOpen = hold.status === 'active' && hold.expiresAt > now;

    let status: CheckoutDto['status'];
    let statusMessage: string | null = null;
    if (!booking) {
      status = holdOpen
        ? 'open'
        : hold.status === 'failed'
          ? 'failed'
          : hold.status === 'cancelled'
            ? 'cancelled'
            : 'expired';
    } else if (booking.status === 'pending_payment') {
      status = holdOpen ? 'awaiting_payment' : 'expired';
    } else if (booking.status === 'reserving') {
      status = 'processing';
    } else {
      status = booking.status;
    }
    if (status === 'expired')
      statusMessage = 'This hold has expired. Ask your assistant to check availability again.';
    if (status === 'processing')
      statusMessage = 'Payment received. We’re confirming your reservation with the hotel…';
    if (status === 'failed')
      statusMessage = booking?.statusReason ?? hold.statusReason ?? 'This booking could not be completed.';
    if (status === 'failed' && booking?.paymentMode === 'prepaid') {
      statusMessage += ' Your card has not been charged; any authorization is released.';
    }

    let payment: CheckoutDto['payment'] = null;
    if (status === 'awaiting_payment' && booking) {
      const secret = booking.paymentIntentId
        ? (await this.deps.payments.getPaymentIntent(booking.paymentAccountId, booking.paymentIntentId))
            .clientSecret
        : booking.setupIntentId
          ? (await this.deps.payments.getSetupIntent(booking.paymentAccountId, booking.setupIntentId))
              .clientSecret
          : null;
      if (secret) {
        payment = {
          provider: 'stripe',
          publishableKey: this.deps.payments.publishableKey,
          accountId: booking.paymentAccountId,
          kind: booking.paymentIntentId ? 'payment' : 'setup',
          clientSecret: secret,
          simulatorUrl: this.deps.payments.simulated ? this.deps.simulatorUrl : null,
        };
      }
    }

    return {
      status,
      statusMessage,
      expiresAt: hold.expiresAt.toISOString(),
      hotel: {
        name: property.name,
        address:
          [
            property.addressLine1,
            [property.postalCode, property.city].filter(Boolean).join(' '),
            property.countryCode,
          ]
            .filter(Boolean)
            .join(', ') || null,
        logoUrl: property.logoUrl,
        brandColor: property.brandColor,
        email: property.email,
        phone: property.phone,
        checkInTime: property.checkInTime,
        checkOutTime: property.checkOutTime,
        profileUrl: `${this.deps.webBaseUrl}/hotels/${property.slug}`,
      },
      stay: {
        checkIn: hold.arrival,
        checkOut: hold.departure,
        nights: nightsBetween(hold.arrival, hold.departure),
        adults: hold.adults,
        childrenAges: hold.childrenAges,
        roomType: hold.offer.roomTypeName,
        ratePlan: hold.offer.ratePlanName,
        includes: loaded.includes,
      },
      price: {
        total: money(hold.totalAmount),
        dueNow: money(hold.dueNowAmount),
        dueAtHotel: money(hold.totalAmount - hold.dueNowAmount),
        accommodation: toDisplayMoney(hold.offer.accommodation),
        includedTaxes: toDisplayMoney(hold.offer.includedTaxes),
        extras: hold.offer.extras.map((e) => ({ label: e.label, amount: toDisplayMoney(e.amount) })),
      },
      paymentMode: hold.paymentMode,
      cancellation: this.cancellationText(hold, property),
      policies: loaded.policies.map(({ title, description }) => ({ title, description })),
      guest:
        booking?.guestFirstName && booking.guestEmail
          ? {
              firstName: booking.guestFirstName,
              lastName: booking.guestLastName ?? '',
              email: booking.guestEmail,
              phone: booking.guestPhone,
            }
          : null,
      booking: booking
        ? { reference: booking.reference, confirmationNumber: booking.confirmationNumber }
        : null,
      payment,
    };
  }
}
