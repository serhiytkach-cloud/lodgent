import { type Clock, RateLimitedError } from '@lodgent/core';
import {
  type AuditEntry,
  type Database,
  type GuestBookingRow,
  IN_FLIGHT_BOOKING_STATUSES,
  type TenantRepos,
} from '@lodgent/db';
import {
  addDays,
  type GuestBookingExportDto,
  type GuestDataEraseDto,
  type GuestDataEraseInput,
  type GuestDataExportDto,
  type GuestDataExportInput,
  localDateAt,
  nightsBetween,
} from '@lodgent/shared';
import type { Logger } from 'pino';
import { assertCan, type OrgContext, systemActor, userActor } from '../context';
import type { Signer } from '../infra/signing';
import { redactForLog } from './agent-log';

/**
 * How long each kind of data is kept (docs/privacy.md). Booking guest details themselves are kept
 * for `PII_RETENTION_DAYS` after departure (config), because the hotel needs them around the stay.
 */
export const RETENTION = {
  /** Failed checkouts never became reservations; their details are kept briefly for support questions. */
  failedCheckoutPiiDays: 7,
  /** Delivered outbox messages. Email payloads are scrubbed at delivery; job payloads carry ids only. */
  dispatchedOutboxDays: 7,
  /** Emails still undeliverable after this long are dropped together with their recipient and content. */
  undeliveredEmailDays: 3,
  /** Finished jobs in the Postgres queue (local and test stand-in for SQS). */
  completedJobDays: 7,
  failedJobDays: 30,
  /** Webhook de-duplication records (ids and types only; providers stop retrying within days). */
  webhookEventDays: 90,
} as const;

/** Export and erasure requests allowed per organization per rolling hour (on top of the per-IP route limit). */
export const GUEST_DATA_REQUESTS_PER_HOUR = 60;
const GUEST_DATA_ACTIONS = ['guest_data.exported', 'guest_data.erased'];
const DAY_MS = 86_400_000;

export interface RetentionResult {
  bookingsRedacted: number;
  outboxDeleted: number;
  undeliveredEmailsDropped: number;
  jobsDeleted: number;
  webhookEventsDeleted: number;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Guest privacy (ADR 0015): data subject access (export) and erasure for a guest's bookings within
 * one organization, and the daily retention job that erases guest details after the stay and purges
 * other rows that carried them.
 *
 * Erasure redacts in place (guest fields emptied, `pii_redacted_at` set): the booking, its amounts and
 * fees stay, because the hotel and our invoicing still need them; nothing left identifies the guest.
 */
export class PrivacyService {
  constructor(
    private readonly deps: {
      db: Database;
      clock: Clock;
      signer: Signer;
      logger: Logger;
      piiRetentionDays: number;
    },
  ) {}

  /** Pseudonymous, per-organization reference for a guest email: the same guest in two orgs differs. */
  subjectRef(orgId: string, email: string): string {
    return `g_${this.deps.signer.digest('guest-ref', `${orgId}\n${email.trim().toLowerCase()}`).slice(0, 32)}`;
  }

  private async enforceQuota(r: TenantRepos, now: Date): Promise<void> {
    const recent = await r.audit.countSince(GUEST_DATA_ACTIONS, new Date(now.getTime() - 3_600_000));
    if (recent >= GUEST_DATA_REQUESTS_PER_HOUR) {
      throw new RateLimitedError(
        'Too many guest data requests for this organization in the last hour. Try again later.',
      );
    }
  }

  /** Everything we hold about the guest with this email in the caller's organization. */
  async export(ctx: OrgContext, input: GuestDataExportInput): Promise<GuestDataExportDto> {
    assertCan(ctx, 'guest-data.manage');
    const now = this.deps.clock.now();
    const email = input.email.trim().toLowerCase();
    const ref = this.subjectRef(ctx.orgId, email);
    return this.deps.db.tenant(ctx.orgId, async (r) => {
      await this.enforceQuota(r, now);
      const org = await r.organization.get();
      const rows = await r.bookings.byGuestEmail(email);
      await r.audit.record({
        ...userActor(ctx),
        action: 'guest_data.exported',
        entityType: 'guest',
        entityId: ref,
        changes: { bookings: rows.length, references: rows.map((row) => row.booking.reference) },
      });
      return {
        generatedAt: now.toISOString(),
        organization: { id: ctx.orgId, name: org?.name ?? '' },
        subject: { email, ref },
        bookings: rows.map((row) => this.toExport(row)),
        notes: this.exportNotes(),
      };
    });
  }

  /**
   * Erases the guest's details on all their bookings in the caller's organization. Idempotent: erased
   * bookings no longer match the email. Checkouts still running are skipped (`deferred`), because
   * finalization reads the guest's details to create the reservation; they settle within the hour.
   */
  async erase(ctx: OrgContext, input: GuestDataEraseInput): Promise<GuestDataEraseDto> {
    assertCan(ctx, 'guest-data.manage');
    const now = this.deps.clock.now();
    const email = input.email.trim().toLowerCase();
    const ref = this.subjectRef(ctx.orgId, email);
    return this.deps.db.tenant(ctx.orgId, async (r) => {
      await this.enforceQuota(r, now);
      const rows = await r.bookings.byGuestEmail(email);
      const erasedIds = new Set(
        await r.bookings.redactGuestData(
          rows.map((row) => row.booking.id),
          now,
          { exceptStatuses: IN_FLIGHT_BOOKING_STATUSES },
        ),
      );
      const erased = rows.filter((row) => erasedIds.has(row.booking.id));
      const deferred = rows.filter((row) => !erasedIds.has(row.booking.id));
      const pendingEmailsDropped = await r.outbox.deletePendingGuestEmails(email);

      const reason = redactForLog(input.reason, 200);
      await r.audit.recordMany([
        ...erased.map(
          (row): AuditEntry => ({
            ...userActor(ctx),
            action: 'booking.guest_data_redacted',
            entityType: 'booking',
            entityId: row.booking.id,
            changes: { trigger: 'erasure_request', subject: ref },
          }),
        ),
        {
          ...userActor(ctx),
          action: 'guest_data.erased',
          entityType: 'guest',
          entityId: ref,
          changes: {
            matched: rows.length,
            erased: erased.map((row) => row.booking.reference),
            deferred: deferred.map((row) => row.booking.reference),
            pendingEmailsDropped,
            reason,
          },
        },
      ]);

      return {
        subject: { ref },
        matched: rows.length,
        erased: erased.length,
        deferred: deferred.length,
        pendingEmailsDropped,
        bookings: rows.map((row) => ({
          id: row.booking.id,
          reference: row.booking.reference,
          propertyName: row.propertyName,
          arrival: row.booking.arrival,
          departure: row.booking.departure,
          status: row.booking.status,
          result: erasedIds.has(row.booking.id) ? ('erased' as const) : ('deferred' as const),
        })),
        warnings: this.erasureWarnings(erased, deferred, now),
      };
    });
  }

  private erasureWarnings(erased: GuestBookingRow[], deferred: GuestBookingRow[], now: Date): string[] {
    const warnings: string[] = [];
    const ongoing = erased.filter(
      ({ booking, timeZone }) =>
        booking.status === 'confirmed' && booking.departure >= localDateAt(now, timeZone),
    );
    if (ongoing.length > 0) {
      warnings.push(
        `${ongoing.length} erased booking${ongoing.length === 1 ? ' is' : 's are'} upcoming or in progress (${ongoing
          .map((row) => row.booking.reference)
          .join(
            ', ',
          )}). The reservation stays valid in your PMS, which still holds the guest's details: handle the stay and any erasure there.`,
      );
    }
    if (erased.some(({ booking }) => booking.pmsReservationId)) {
      warnings.push(
        "Your PMS (Apaleo) is the system of record for reservations and keeps its own copy of the guest's details. Erase or anonymize them there as well if the request covers it.",
      );
    }
    if (erased.some(({ booking }) => booking.paymentIntentId || booking.setupIntentId)) {
      warnings.push(
        'Payment records (receipt email, the customer and saved card for pay-at-hotel guarantees) are held by Stripe in your own Stripe account. Delete them in your Stripe Dashboard if required.',
      );
    }
    if (deferred.length > 0) {
      warnings.push(
        `${deferred.length} booking${deferred.length === 1 ? ' is' : 's are'} still in checkout and ${deferred.length === 1 ? 'was' : 'were'} not erased. Run the erasure again in about an hour, once checkout has finished.`,
      );
    }
    return warnings;
  }

  private toExport({ booking: b, propertyName, timeZone, offer }: GuestBookingRow): GuestBookingExportDto {
    const redacted = b.piiRedactedAt !== null;
    return {
      id: b.id,
      reference: b.reference,
      status: b.status,
      property: { id: b.propertyId, name: propertyName },
      stay: {
        arrival: b.arrival,
        departure: b.departure,
        nights: nightsBetween(b.arrival, b.departure),
        adults: b.adults,
        childrenAges: b.childrenAges,
        roomType: offer.roomTypeName,
        ratePlan: offer.ratePlanName,
        timeZone,
      },
      price: {
        currency: b.currency,
        total: { amount: b.totalAmount, currency: b.currency },
        dueAtBooking: { amount: b.dueNowAmount, currency: b.currency },
        paymentMode: b.paymentMode,
        paymentStatus: b.paymentStatus,
      },
      guest: {
        firstName: redacted ? null : b.guestFirstName,
        lastName: redacted ? null : b.guestLastName,
        email: redacted ? null : b.guestEmail,
        phone: redacted ? null : b.guestPhone,
        specialRequests: redacted ? null : b.specialRequests,
      },
      confirmationNumber: b.confirmationNumber,
      bookedVia: b.channel,
      termsAcceptedAt: iso(b.termsAcceptedAt),
      createdAt: b.createdAt.toISOString(),
      updatedAt: b.updatedAt.toISOString(),
      confirmedAt: iso(b.confirmedAt),
      cancelledAt: iso(b.cancelledAt),
    };
  }

  private exportNotes(): string[] {
    return [
      'This export covers the bookings made through AI agents and our hosted checkout for this organization. Agent search logs never contain guest details.',
      `Guest details are erased automatically ${this.deps.piiRetentionDays} days after departure (${RETENTION.failedCheckoutPiiDays} days after a checkout that failed). Amounts, dates and references are kept for accounting.`,
      "The reservation itself, with the guest's details, is held in the hotel's property management system (Apaleo).",
      "Card payments and saved cards are processed by Stripe on the hotel's own Stripe account; card numbers never reach us.",
    ];
  }

  // ---- retention -----------------------------------------------------------------------------

  /**
   * Daily retention job. Each step works in bounded batches, each batch in its own short
   * transaction, and only touches rows still due, so a crash or a concurrent run is harmless: the
   * next run carries on where this one stopped.
   */
  async runRetention(options: { batchSize?: number; maxBatches?: number } = {}): Promise<RetentionResult> {
    const { db, clock, logger } = this.deps;
    const batchSize = options.batchSize ?? 200;
    const maxBatches = options.maxBatches ?? 50;
    const now = clock.now();
    const before = (days: number) => new Date(now.getTime() - days * DAY_MS);

    const result: RetentionResult = {
      bookingsRedacted: await this.redactDueBookings(now, batchSize, maxBatches),
      outboxDeleted: 0,
      undeliveredEmailsDropped: 0,
      jobsDeleted: 0,
      webhookEventsDeleted: 0,
    };

    const repeat = async (step: () => Promise<number>): Promise<number> => {
      let total = 0;
      for (let i = 0; i < maxBatches; i++) {
        const n = await step();
        total += n;
        if (n < batchSize) break;
      }
      return total;
    };

    result.outboxDeleted = await repeat(() =>
      db.system(({ outbox }) =>
        outbox.deleteDispatchedBefore(before(RETENTION.dispatchedOutboxDays), batchSize),
      ),
    );
    result.undeliveredEmailsDropped = await repeat(async () => {
      const dropped = await db.system(({ outbox }) =>
        outbox.deleteUndeliveredEmails(before(RETENTION.undeliveredEmailDays), batchSize),
      );
      if (dropped.length > 0) {
        logger.warn(
          { outboxIds: dropped.map((d) => d.id), attempts: dropped.map((d) => d.attempts) },
          'gave up on undeliverable emails; recipients and content deleted',
        );
      }
      return dropped.length;
    });
    result.jobsDeleted = await repeat(() =>
      db.system(({ jobs }) =>
        jobs.deleteFinished(
          {
            completedBefore: before(RETENTION.completedJobDays),
            failedBefore: before(RETENTION.failedJobDays),
          },
          batchSize,
        ),
      ),
    );
    result.webhookEventsDeleted = await repeat(() =>
      db.system(({ pms }) => pms.deleteWebhookEventsBefore(before(RETENTION.webhookEventDays), batchSize)),
    );
    return result;
  }

  /** Erases guest details on bookings past retention, org by org (tenant transactions, audited). */
  private async redactDueBookings(now: Date, batchSize: number, maxBatches: number): Promise<number> {
    const { db, piiRetentionDays } = this.deps;
    const cutoffs = {
      departedBefore: addDays(localDateAt(now, 'UTC'), -piiRetentionDays),
      failedBefore: new Date(now.getTime() - RETENTION.failedCheckoutPiiDays * DAY_MS),
    };
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      // Cross-tenant scan (system context): only ids come back; each org is then redacted in its own tenant transaction.
      const due = await db.system(({ bookings }) => bookings.piiDue(cutoffs, batchSize));
      const byOrg = new Map<string, string[]>();
      for (const { organizationId, bookingId } of due) {
        byOrg.set(organizationId, [...(byOrg.get(organizationId) ?? []), bookingId]);
      }
      let redactedThisBatch = 0;
      for (const [orgId, ids] of byOrg) {
        redactedThisBatch += await db.tenant(orgId, async (r) => {
          const redacted = await r.bookings.redactGuestData(ids, now);
          await r.audit.recordMany(
            redacted.map((id) => ({
              ...systemActor,
              action: 'booking.guest_data_redacted',
              entityType: 'booking',
              entityId: id,
              changes: { trigger: 'retention' },
            })),
          );
          return redacted.length;
        });
      }
      total += redactedThisBatch;
      // Stop when the scan is exhausted, or when nothing could be redacted (never spin on the same rows).
      if (due.length < batchSize || redactedThisBatch === 0) break;
    }
    return total;
  }
}
