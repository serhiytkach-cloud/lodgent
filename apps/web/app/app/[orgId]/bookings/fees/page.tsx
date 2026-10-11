import { type FeesDto, formatMoney } from '@lodgent/shared';
import { Download, ExternalLink } from 'lucide-react';
import { redirect } from 'next/navigation';
import { InvoiceStatusBadge } from '@/components/status';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, PageHeader, Stat, Table, Td, Th } from '@/components/ui/misc';
import { api } from '@/lib/api';
import type { Organization } from '@/lib/types';
import { formatDate } from '@/lib/utils';
import { BookingTabs } from '../tabs';

const monthLabel = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y!, m! - 1, 1)),
  );
};

export default async function FeesPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const org = await api<Organization>(`/v1/orgs/${orgId}`);
  if (org.role === 'viewer') redirect(`/app/${orgId}/bookings`);
  const fees = await api<FeesDto>(`/v1/orgs/${orgId}/fees`);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const current = fees.months.filter((m) => m.period === thisMonth);
  const sum = (key: 'collected' | 'pending' | 'invoiced', rows = fees.months) =>
    rows.length === 0
      ? '—'
      : [...new Set(rows.map((r) => r.currency))]
          .map((currency) =>
            formatMoney({
              amount: rows.filter((r) => r.currency === currency).reduce((s, r) => s + r[key], 0),
              currency,
            }),
          )
          .join(' · ');
  const rates = [...new Set(fees.properties.map((p) => p.feeBps))];
  const openInvoices = fees.invoices.filter((i) => i.status === 'open');

  return (
    <>
      <PageHeader
        title="Bookings & fees"
        description="You pay a fee only on bookings that AI agents bring you. Prepaid bookings settle it automatically; pay-at-hotel fees are invoiced monthly after the stay."
      />
      <BookingTabs orgId={orgId} active="fees" showFees />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Fee rate"
          value={rates.length === 1 ? `${rates[0]! / 100}%` : rates.length === 0 ? '—' : 'Varies'}
          hint="Of the booking total, per property"
        />
        <Stat
          label="Collected this month"
          value={sum('collected', current)}
          hint="Via Stripe and paid invoices"
        />
        <Stat label="To be invoiced" value={sum('pending')} hint="Pay-at-hotel stays, after check-out" />
        <Stat
          label="Open invoices"
          value={openInvoices.length}
          hint={openInvoices.length > 0 ? 'Payable on Stripe’s invoice page' : 'Nothing due'}
        />
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Monthly fees</CardTitle>
          <CardDescription>
            By the month each booking was confirmed. Download the lines for your accounts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {fees.months.length === 0 ? (
            <EmptyState title="No fees yet.">Fees appear here once an agent booking is confirmed.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Month</Th>
                  <Th className="text-right">Bookings</Th>
                  <Th className="text-right">Booking value</Th>
                  <Th className="text-right">Collected</Th>
                  <Th className="text-right">To invoice</Th>
                  <Th className="text-right">Invoiced</Th>
                  <Th className="text-right">Waived</Th>
                  <Th>
                    <span className="sr-only">Export</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {fees.months.map((m) => {
                  const money = (amount: number) => formatMoney({ amount, currency: m.currency });
                  return (
                    <tr key={`${m.period}-${m.currency}`}>
                      <Td>
                        {monthLabel(m.period)}
                        {fees.months.some((x) => x.period === m.period && x.currency !== m.currency) ? (
                          <span className="ml-1 text-xs text-muted-foreground">{m.currency}</span>
                        ) : null}
                      </Td>
                      <Td className="text-right tabular-nums">{m.bookings}</Td>
                      <Td className="text-right tabular-nums">{money(m.bookingValue)}</Td>
                      <Td className="text-right tabular-nums">{money(m.collected)}</Td>
                      <Td className="text-right tabular-nums">{money(m.pending)}</Td>
                      <Td className="text-right tabular-nums">{money(m.invoiced)}</Td>
                      <Td className="text-right tabular-nums text-muted-foreground">{money(m.void)}</Td>
                      <Td className="text-right">
                        <a
                          href={`/app/${orgId}/exports/fees.csv?period=${m.period}`}
                          download
                          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                        >
                          <Download className="size-3.5" /> CSV
                        </a>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Invoices</CardTitle>
          <CardDescription>
            Pay-at-hotel fees are billed on the first of each month for stays that ended the month before, by
            email to your billing address, due in 14 days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {fees.invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No invoices yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Invoice</Th>
                  <Th>Period</Th>
                  <Th className="text-right">Amount</Th>
                  <Th>Status</Th>
                  <Th>Due</Th>
                  <Th>
                    <span className="sr-only">Links</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {fees.invoices.map((i) => (
                  <tr key={i.id}>
                    <Td className="font-medium">{i.number ?? '—'}</Td>
                    <Td>
                      {monthLabel(i.period)}
                      <span className="block text-xs text-muted-foreground">
                        {i.feeCount} {i.feeCount === 1 ? 'booking' : 'bookings'}
                      </span>
                    </Td>
                    <Td className="text-right tabular-nums">
                      {formatMoney({ amount: i.amount, currency: i.currency })}
                    </Td>
                    <Td>
                      <InvoiceStatusBadge status={i.status} />
                      {i.paidAt ? (
                        <span className="block text-xs text-muted-foreground">
                          Paid {formatDate(i.paidAt)}
                        </span>
                      ) : null}
                    </Td>
                    <Td>{i.dueAt ? formatDate(i.dueAt) : '—'}</Td>
                    <Td className="text-right">
                      {i.hostedUrl ? (
                        <a
                          href={i.hostedUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                        >
                          {i.status === 'open' ? 'Pay' : 'View'} <ExternalLink className="size-3.5" />
                        </a>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>

      {fees.properties.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Fee rates</CardTitle>
            <CardDescription>Agreed per property. Contact us to discuss your rate.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-1 text-sm">
              {fees.properties.map((p) => (
                <li key={p.id} className="flex justify-between">
                  <span>{p.name}</span>
                  <span className="tabular-nums">{p.feeBps / 100}%</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
