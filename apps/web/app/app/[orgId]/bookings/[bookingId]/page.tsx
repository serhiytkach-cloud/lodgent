import { type BookingDetailDto, formatMoney } from '@lodgent/shared';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { BookingStatusBadge, FeeStatusBadge } from '@/components/status';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, Badge, PageHeader } from '@/components/ui/misc';
import { ApiError, api } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/utils';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

export default async function BookingPage({
  params,
}: {
  params: Promise<{ orgId: string; bookingId: string }>;
}) {
  const { orgId, bookingId } = await params;
  const b = await api<BookingDetailDto>(`/v1/orgs/${orgId}/bookings/${bookingId}`).catch((error: unknown) => {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  });
  const money = (amount: number) => formatMoney({ amount, currency: b.currency });

  return (
    <>
      <Link
        href={`/app/${orgId}/bookings`}
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Bookings
      </Link>
      <PageHeader
        title={`Booking ${b.reference}`}
        description={`${b.propertyName} · booked ${formatDateTime(b.createdAt)} by ${b.agent.name}`}
        actions={<BookingStatusBadge status={b.status} />}
      />
      {b.status === 'failed' && b.statusReason ? (
        <Alert variant="error" className="mb-4" title="This booking did not complete">
          {b.statusReason} Any payment authorization was released.
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Guest</CardTitle>
          </CardHeader>
          <CardContent>
            {b.piiRedactedAt ? (
              <p className="text-sm text-muted-foreground">
                Guest details were erased on {formatDate(b.piiRedactedAt)}, under the data retention policy or
                at the guest’s request.
              </p>
            ) : (
              <dl>
                <Row label="Name">{b.guestName ?? '—'}</Row>
                <Row label="Email">
                  {b.guestEmail ?? <span className="text-muted-foreground">Hidden</span>}
                </Row>
                <Row label="Phone">{b.guestPhone ?? <span className="text-muted-foreground">—</span>}</Row>
                <Row label="Requests">{b.specialRequests ?? '—'}</Row>
              </dl>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Stay</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <Row label="Dates">
                {formatDate(b.arrival)} → {formatDate(b.departure)} ({b.nights}{' '}
                {b.nights === 1 ? 'night' : 'nights'})
              </Row>
              <Row label="Guests">
                {b.adults} {b.adults === 1 ? 'adult' : 'adults'}
                {b.children > 0 ? `, ${b.children} ${b.children === 1 ? 'child' : 'children'}` : ''}
              </Row>
              <Row label="Room">{b.roomTypeName}</Row>
              <Row label="Rate">{b.ratePlanName}</Row>
              <Row label="Cancellation">
                {b.cancellation.name ?? '—'}
                {b.cancellation.freeUntil && new Date(b.cancellation.freeUntil) > new Date(b.createdAt) ? (
                  <span className="block text-xs text-muted-foreground">
                    Free until {formatDateTime(b.cancellation.freeUntil)}
                  </span>
                ) : null}
              </Row>
              <Row label="Reservation">
                {b.confirmationNumber ? (
                  b.pmsUrl ? (
                    <a
                      href={b.pmsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      {b.confirmationNumber} in Apaleo <ExternalLink className="size-3.5" />
                    </a>
                  ) : (
                    b.confirmationNumber
                  )
                ) : (
                  <span className="text-muted-foreground">Not created</span>
                )}
              </Row>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Price</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              {b.price.nightly.map((n) => (
                <Row key={n.date} label={formatDate(n.date)}>
                  <span className="tabular-nums">{money(n.amount)}</span>
                </Row>
              ))}
              {b.price.extras.map((e) => (
                <Row key={e.label} label={e.label}>
                  <span className="tabular-nums">{money(e.amount)}</span>
                </Row>
              ))}
              {b.price.includedTaxes > 0 ? (
                <Row label="Included taxes">
                  <span className="tabular-nums text-muted-foreground">{money(b.price.includedTaxes)}</span>
                </Row>
              ) : null}
              <div className="mt-2 border-t pt-2">
                <Row label="Total">
                  <span className="font-semibold tabular-nums">{money(b.totalAmount)}</span>
                </Row>
                <Row label={b.paymentMode === 'prepaid' ? 'Paid online' : 'Due at the hotel'}>
                  <span className="tabular-nums">
                    {money(b.paymentMode === 'prepaid' ? b.dueNowAmount : b.totalAmount)}
                  </span>
                </Row>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payment and fee</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <Row label="Payment">
                {b.paymentMode === 'prepaid' ? 'Prepaid by card' : 'Pay at hotel (card guarantee)'}
                <span className="block text-xs text-muted-foreground">
                  {b.payment.status.replaceAll('_', ' ')}
                </span>
              </Row>
              {b.payment.paymentIntentId || b.payment.setupIntentId ? (
                <Row label="Stripe">
                  {b.payment.dashboardUrl ? (
                    <a
                      href={b.payment.dashboardUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      View in Stripe <ExternalLink className="size-3.5" />
                    </a>
                  ) : (
                    <code className="text-xs">{b.payment.paymentIntentId ?? b.payment.setupIntentId}</code>
                  )}
                </Row>
              ) : null}
              <Row label={`Fee (${(b.feeBps / 100).toLocaleString('en', { maximumFractionDigits: 2 })}%)`}>
                <span className="tabular-nums">{money(b.fee?.amount ?? b.feeAmount)}</span>
              </Row>
              <Row label="Fee status">
                <FeeStatusBadge status={b.fee?.status ?? null} />
                {b.fee ? (
                  <span className="block text-xs text-muted-foreground">
                    {b.fee.collection === 'application_fee'
                      ? 'Taken from the payment by Stripe'
                      : b.fee.invoiceNumber
                        ? `On invoice ${b.fee.invoiceNumber}`
                        : 'Invoiced monthly after the stay'}
                  </span>
                ) : null}
              </Row>
              <Row label="Agent">
                {b.agent.name}{' '}
                <Badge variant="outline" className="ml-1">
                  {b.agent.channel.toUpperCase()}
                </Badge>
              </Row>
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-2">
            {b.timeline.map((t) => (
              <li key={`${t.at}-${t.label}`} className="flex gap-3 text-sm">
                <span className="w-44 shrink-0 text-muted-foreground tabular-nums">
                  {formatDateTime(t.at)}
                </span>
                <span>{t.label}</span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </>
  );
}
