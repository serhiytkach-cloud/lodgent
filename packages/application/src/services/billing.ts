import {
  type BillingInvoiceInfo,
  type Clock,
  INVOICE_DAYS_UNTIL_DUE,
  type JobQueue,
  MIN_INVOICE_AMOUNT,
  NotFoundError,
  type PaymentProvider,
  periodLabel,
  previousBillingPeriod,
  toCsv,
} from '@lodgent/core';
import type { Database, FeeInvoiceRow, TenantRepos } from '@lodgent/db';
import { BRAND, type FeeInvoiceDto, type FeesDto, toMajor } from '@lodgent/shared';
import type { Logger } from 'pino';
import { assertCan, type OrgContext, systemActor } from '../context';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toInvoiceDto(row: FeeInvoiceRow): FeeInvoiceDto {
  return {
    id: row.id,
    period: row.period,
    currency: row.currency,
    amount: row.amount,
    feeCount: row.feeCount,
    status: row.status,
    number: row.number,
    hostedUrl: row.hostedUrl,
    pdfUrl: row.pdfUrl,
    dueAt: iso(row.dueAt),
    issuedAt: iso(row.issuedAt),
    paidAt: iso(row.paidAt),
  };
}

/**
 * Platform fees. Prepaid bookings pay the fee as a Stripe application fee at capture; pay-at-hotel
 * fees accrue in the ledger and are invoiced monthly, after the stay, through Stripe Billing on the
 * platform account (one invoice per hotel group, period and currency, payable on Stripe's hosted
 * invoice page). Invoice rows are written before Stripe is called, so retries are idempotent.
 */
export class BillingService {
  constructor(
    private readonly deps: {
      db: Database;
      clock: Clock;
      payments: PaymentProvider;
      queue: JobQueue;
      logger: Logger;
    },
  ) {}

  async fees(ctx: OrgContext): Promise<FeesDto> {
    assertCan(ctx, 'billing.read');
    const now = this.deps.clock.now();
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
    return this.deps.db.tenant(ctx.orgId, async (r) => {
      const properties = await r.properties.list();
      const totals = await r.billing.monthlyTotals(since);
      const invoices = await r.billing.invoices();
      const months = new Map<string, FeesDto['months'][number]>();
      for (const t of totals) {
        const key = `${t.period}:${t.currency}`;
        const m = months.get(key) ?? {
          period: t.period,
          currency: t.currency,
          bookings: 0,
          bookingValue: 0,
          collected: 0,
          pending: 0,
          invoiced: 0,
          void: 0,
        };
        m.bookings += t.count;
        if (t.status !== 'void') m.bookingValue += t.bookingTotal;
        m[t.status] += t.amount;
        months.set(key, m);
      }
      return {
        properties: properties.map((p) => ({ id: p.id, name: p.name, feeBps: p.feeBps })),
        months: [...months.values()].sort(
          (a, b) => b.period.localeCompare(a.period) || a.currency.localeCompare(b.currency),
        ),
        invoices: invoices.map(toInvoiceDto),
      };
    });
  }

  /** Fee ledger lines for bookings confirmed in a month (UTC), for accounting. */
  async feesCsv(ctx: OrgContext, period: string): Promise<string> {
    assertCan(ctx, 'billing.read');
    const [y, m] = period.split('-').map(Number);
    const from = new Date(Date.UTC(y!, m! - 1, 1));
    const to = new Date(Date.UTC(y!, m!, 1));
    const { lines, invoices } = await this.deps.db.tenant(ctx.orgId, async (r) => ({
      lines: await r.billing.lines({ from, to }),
      invoices: await r.billing.invoices(1_000),
    }));
    const numbers = new Map(invoices.map((i) => [i.id, i.number]));
    return toCsv(
      [
        'confirmed_at',
        'reference',
        'property',
        'arrival',
        'departure',
        'booking_status',
        'collection',
        'fee_status',
        'fee_percent',
        'currency',
        'booking_total',
        'fee',
        'invoice_number',
      ],
      lines.map((l) => [
        l.fee.occurredAt.toISOString(),
        l.reference,
        l.propertyName,
        l.arrival,
        l.departure,
        l.bookingStatus,
        l.fee.collection === 'application_fee' ? 'stripe_application_fee' : 'monthly_invoice',
        l.fee.status,
        l.fee.feeBps / 100,
        l.fee.currency,
        toMajor({ amount: l.fee.bookingTotalAmount, currency: l.fee.currency }),
        toMajor({ amount: l.fee.amount, currency: l.fee.currency }),
        l.fee.invoiceId ? (numbers.get(l.fee.invoiceId) ?? '') : '',
      ]),
    );
  }

  // ---- invoicing ---------------------------------------------------------------------------

  /**
   * Daily job: invoice last month's pay-at-hotel fees (a no-op once done for the period) and
   * re-check invoices still draft or open, in case a run stopped half-way or a webhook was lost.
   */
  async runDaily(): Promise<{ orgs: number; synced: number }> {
    const { db, queue, clock } = this.deps;
    const { period, departedBefore } = previousBillingPeriod(clock.now());
    const orgs = await db.system(({ billing }) => billing.orgsWithUninvoicedFees(departedBefore));
    for (const orgId of orgs) {
      await queue.enqueue({
        type: 'billing.invoice-org',
        payload: { orgId, period, departedBefore },
        dedupeKey: `billing:${orgId}:${period}:${clock.now().toISOString().slice(0, 10)}`,
      });
    }
    const pending = await db.system(async ({ billing }) => [
      ...(await billing.draftInvoices()),
      ...(await billing.openInvoices()),
    ]);
    for (const inv of pending) {
      await queue.enqueue({
        type: 'billing.invoice-sync',
        payload: { orgId: inv.organizationId, feeInvoiceId: inv.id },
        dedupeKey: `billing-sync:${inv.id}:${clock.now().toISOString().slice(0, 10)}`,
      });
    }
    return { orgs: orgs.length, synced: pending.length };
  }

  /** Creates (once) and issues the period's invoice per currency for one hotel group. */
  async invoiceOrg(orgId: string, period: string, departedBefore: string): Promise<FeeInvoiceRow[]> {
    const { db, logger } = this.deps;
    const currencies = await db.tenant(orgId, (r) => r.billing.pendingCurrencies(departedBefore));
    const issued: FeeInvoiceRow[] = [];
    for (const currency of currencies) {
      const row = await db.tenant(orgId, async (r) => {
        const existing = await r.billing.invoiceFor(period, currency);
        if (existing) return existing; // later fees for this period roll into next month's invoice
        const lines = await r.billing.uninvoicedForStaysBefore(departedBefore, currency);
        const amount = lines.reduce((sum, l) => sum + l.fee.amount, 0);
        if (amount < MIN_INVOICE_AMOUNT) return null; // too small to bill; rolls over
        const created = await r.billing.createInvoice({ period, currency, amount, feeCount: lines.length });
        if (!created) return (await r.billing.invoiceFor(period, currency)) ?? null;
        await r.billing.assignToInvoice(
          lines.map((l) => l.fee.id),
          created.id,
        );
        await r.audit.record({
          ...systemActor,
          action: 'billing.invoice_created',
          entityType: 'fee_invoice',
          entityId: created.id,
          changes: { period, currency, amount, fees: lines.length },
        });
        return created;
      });
      if (!row) {
        logger.info({ orgId, period, currency }, 'fees below the minimum invoice amount; rolling over');
        continue;
      }
      issued.push(row.status === 'draft' ? await this.issue(orgId, row) : row);
    }
    return issued;
  }

  private async billingCustomer(orgId: string): Promise<string> {
    const { db, payments } = this.deps;
    const { org, members } = await db.tenant(orgId, async (r) => ({
      org: await r.organization.get(),
      members: await r.members.list(),
    }));
    if (!org) throw new NotFoundError('Organization');
    if (org.stripeCustomerId) return org.stripeCustomerId;
    const owner = members.find((m) => m.role === 'owner');
    const customerId = await payments.createBillingCustomer({
      name: org.name,
      email: org.billingEmail ?? owner?.email ?? null,
      metadata: { orgId },
      idempotencyKey: `billing-customer:${orgId}`,
    });
    await db.tenant(orgId, (r) => r.organization.update({ stripeCustomerId: customerId }));
    return customerId;
  }

  /** Issues a draft invoice at the provider. Idempotent: keys derive from the invoice row id. */
  private async issue(orgId: string, row: FeeInvoiceRow): Promise<FeeInvoiceRow> {
    const { db, payments } = this.deps;
    const customerId = await this.billingCustomer(orgId);
    const lines = await db.tenant(orgId, (r) => r.billing.lines({ invoiceId: row.id }));
    const byProperty = new Map<string, { amount: number; count: number }>();
    for (const l of lines) {
      const p = byProperty.get(l.propertyName) ?? { amount: 0, count: 0 };
      p.amount += l.fee.amount;
      p.count += 1;
      byProperty.set(l.propertyName, p);
    }
    const label = periodLabel(row.period);
    const info = await payments.issueInvoice({
      customerId,
      currency: row.currency,
      description: `${BRAND.name} fees for AI-agent bookings paid at the hotel, stays ended by ${label}.`,
      lines: [...byProperty.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, p]) => ({
          amount: p.amount,
          description: `${name}: ${p.count} agent booking${p.count === 1 ? '' : 's'} (${label})`,
        })),
      daysUntilDue: INVOICE_DAYS_UNTIL_DUE,
      metadata: { orgId, feeInvoiceId: row.id, period: row.period },
      idempotencyKey: `fee-invoice:${row.id}`,
    });
    return db.tenant(orgId, (r) => this.apply(r, row, info));
  }

  private async apply(r: TenantRepos, row: FeeInvoiceRow, info: BillingInvoiceInfo): Promise<FeeInvoiceRow> {
    const updated = await r.billing.updateInvoice(row.id, {
      providerInvoiceId: info.id,
      status: info.status,
      number: info.number,
      hostedUrl: info.hostedUrl,
      pdfUrl: info.pdfUrl,
      dueAt: info.dueAt,
      issuedAt: row.issuedAt ?? (info.status !== 'draft' ? this.deps.clock.now() : null),
      paidAt: info.paidAt,
    });
    if (info.status === 'paid' && row.status !== 'paid') {
      await r.billing.setFeeStatusForInvoice(row.id, 'collected');
    } else if (info.status === 'void' && row.status !== 'void') {
      // Voiding the invoice in the Stripe Dashboard waives its fees.
      await r.billing.setFeeStatusForInvoice(row.id, 'void');
    }
    if (info.status !== row.status) {
      await r.audit.record({
        ...systemActor,
        action: `billing.invoice_${info.status}`,
        entityType: 'fee_invoice',
        entityId: row.id,
        changes: { status: { from: row.status, to: info.status }, number: info.number },
      });
    }
    return updated ?? row;
  }

  /** Brings an invoice row up to date with the provider (issuing it if it is still a draft). */
  async syncInvoice(
    orgId: string,
    feeInvoiceId: string,
    providerInvoiceId?: string,
  ): Promise<FeeInvoiceRow | null> {
    const { db, payments, logger } = this.deps;
    const row = await db.tenant(orgId, (r) => r.billing.invoice(feeInvoiceId));
    if (!row) return null;
    const id = row.providerInvoiceId ?? providerInvoiceId;
    if (!id) return row.status === 'draft' ? this.issue(orgId, row) : row;
    const info = await payments.getInvoice(id);
    if (info.metadata.feeInvoiceId !== row.id) {
      logger.warn({ feeInvoiceId, providerInvoiceId: id }, 'provider invoice belongs to another fee invoice');
      return row;
    }
    return db.tenant(orgId, (r) => this.apply(r, row, info));
  }

  /** Maps a provider invoice event to our invoice row (by stored id, or the id we put in metadata). */
  async resolveInvoiceEvent(event: {
    invoiceId: string;
    metadata: Record<string, string>;
  }): Promise<{ orgId: string; feeInvoiceId: string } | null> {
    return this.deps.db.system(async ({ billing }) => {
      const byProvider = await billing.byProviderInvoice(event.invoiceId);
      if (byProvider) return { orgId: byProvider.organizationId, feeInvoiceId: byProvider.id };
      const candidate = event.metadata.feeInvoiceId;
      if (!candidate || !/^[0-9a-f-]{36}$/i.test(candidate)) return null;
      const owner = await billing.invoiceOwner(candidate);
      return owner ? { orgId: owner.organizationId, feeInvoiceId: candidate } : null;
    });
  }
}
