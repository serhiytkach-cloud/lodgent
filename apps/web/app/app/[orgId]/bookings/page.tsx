import { type BookingListDto, formatMoney } from '@lodgent/shared';
import { Download } from 'lucide-react';
import Link from 'next/link';
import { BOOKING_STATUSES, BookingStatusBadge, FeeStatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/form';
import { Badge, EmptyState, PageHeader, Table, Td, Th } from '@/components/ui/misc';
import { api } from '@/lib/api';
import type { Organization, Property } from '@/lib/types';
import { formatDate, formatDateTime } from '@/lib/utils';
import { BookingTabs } from './tabs';

const PAGE_SIZE = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Search = { property?: string; status?: string; q?: string; page?: string };

export default async function BookingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Search>;
}) {
  const { orgId } = await params;
  const s = await searchParams;
  const page = Math.max(1, Number.parseInt(s.page ?? '1', 10) || 1);
  const filters = new URLSearchParams();
  // Ignore malformed filters from hand-edited URLs rather than failing the page.
  if (s.property && UUID.test(s.property)) filters.set('propertyId', s.property);
  if (s.status && BOOKING_STATUSES.some((x) => x.value === s.status)) filters.set('status', s.status);
  if (s.q && s.q.trim().length >= 2) filters.set('q', s.q.trim());
  const query = new URLSearchParams(filters);
  query.set('limit', String(PAGE_SIZE));
  query.set('offset', String((page - 1) * PAGE_SIZE));

  const [org, { properties }, list] = await Promise.all([
    api<Organization>(`/v1/orgs/${orgId}`),
    api<{ properties: Property[] }>(`/v1/orgs/${orgId}/properties`),
    api<BookingListDto>(`/v1/orgs/${orgId}/bookings?${query}`),
  ]);
  const pages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  const pageHref = (n: number) => {
    const p = new URLSearchParams();
    if (s.property) p.set('property', s.property);
    if (s.status) p.set('status', s.status);
    if (s.q) p.set('q', s.q);
    if (n > 1) p.set('page', String(n));
    const qs = p.toString();
    return `/app/${orgId}/bookings${qs ? `?${qs}` : ''}`;
  };
  const filtered = Boolean(s.property || s.status || s.q);

  return (
    <>
      <PageHeader
        title="Bookings & fees"
        description="Every booking AI agents sent you, with its reservation in Apaleo and the fee it carries."
        actions={
          <Button asChild variant="outline" size="sm">
            <a href={`/app/${orgId}/exports/bookings.csv${filters.size ? `?${filters}` : ''}`} download>
              <Download />
              Export CSV
            </a>
          </Button>
        }
      />
      <BookingTabs orgId={orgId} active="bookings" showFees={org.role !== 'viewer'} />

      <form className="mb-4 flex flex-wrap items-end gap-2" method="get" aria-label="Filter bookings">
        <label htmlFor="f-property" className="grid gap-1 text-xs font-medium text-muted-foreground">
          Property
          <Select id="f-property" name="property" defaultValue={s.property ?? ''} className="w-48">
            <option value="">All properties</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor="f-status" className="grid gap-1 text-xs font-medium text-muted-foreground">
          Status
          <Select id="f-status" name="status" defaultValue={s.status ?? ''} className="w-44">
            <option value="">Any status</option>
            {BOOKING_STATUSES.map((st) => (
              <option key={st.value} value={st.value}>
                {st.label}
              </option>
            ))}
          </Select>
        </label>
        <label htmlFor="f-q" className="grid gap-1 text-xs font-medium text-muted-foreground">
          Search
          <Input
            id="f-q"
            name="q"
            defaultValue={s.q ?? ''}
            placeholder="Reference, confirmation no., surname"
            className="w-64"
          />
        </label>
        <Button type="submit" variant="secondary" size="sm" className="h-9">
          Apply
        </Button>
        {filtered ? (
          <Link
            href={`/app/${orgId}/bookings`}
            className="h-9 px-2 text-sm leading-9 text-muted-foreground hover:underline"
          >
            Clear
          </Link>
        ) : null}
      </form>

      {list.bookings.length === 0 ? (
        <EmptyState title={filtered ? 'No bookings match these filters.' : 'No agent bookings yet.'}>
          {filtered
            ? null
            : 'When an AI agent holds a room and the guest completes checkout, the booking appears here with its fee.'}
        </EmptyState>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Booking</Th>
                <Th>Guest</Th>
                <Th>Stay</Th>
                <Th className="text-right">Total</Th>
                <Th className="text-right">Fee</Th>
                <Th>Status</Th>
                <Th>Agent</Th>
              </tr>
            </thead>
            <tbody>
              {list.bookings.map((b) => (
                <tr key={b.id} className="hover:bg-muted/40">
                  <Td>
                    <Link
                      href={`/app/${orgId}/bookings/${b.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {b.reference}
                    </Link>
                    <p className="text-xs text-muted-foreground">{formatDateTime(b.createdAt)}</p>
                  </Td>
                  <Td>
                    {b.guestName ?? <span className="text-muted-foreground">Erased</span>}
                    {b.confirmationNumber ? (
                      <p className="text-xs text-muted-foreground">PMS {b.confirmationNumber}</p>
                    ) : null}
                  </Td>
                  <Td>
                    <p className="whitespace-nowrap">
                      {formatDate(b.arrival)} → {formatDate(b.departure)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {properties.length > 1 ? `${b.propertyName} · ` : ''}
                      {b.roomTypeName} · {b.nights} {b.nights === 1 ? 'night' : 'nights'}
                    </p>
                  </Td>
                  <Td className="text-right tabular-nums">
                    {formatMoney({ amount: b.totalAmount, currency: b.currency })}
                    <p className="text-xs text-muted-foreground">
                      {b.paymentMode === 'prepaid' ? 'Prepaid' : 'Pay at hotel'}
                    </p>
                  </Td>
                  <Td className="text-right tabular-nums">
                    {formatMoney({ amount: b.feeAmount, currency: b.currency })}
                    <div className="mt-0.5">
                      <FeeStatusBadge status={b.feeStatus} />
                    </div>
                  </Td>
                  <Td>
                    <BookingStatusBadge status={b.status} />
                  </Td>
                  <Td>
                    <span className="text-sm">{b.agent.name}</span>
                    <div className="mt-0.5 flex gap-1">
                      <Badge variant="outline">{b.agent.channel.toUpperCase()}</Badge>
                      {b.agent.partner ? <Badge variant="secondary">Partner</Badge> : null}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {list.total} {list.total === 1 ? 'booking' : 'bookings'}
            </span>
            {pages > 1 ? (
              <span className="flex items-center gap-3">
                {page > 1 ? (
                  <Link href={pageHref(page - 1)} className="hover:underline">
                    Previous
                  </Link>
                ) : null}
                <span>
                  Page {page} of {pages}
                </span>
                {page < pages ? (
                  <Link href={pageHref(page + 1)} className="hover:underline">
                    Next
                  </Link>
                ) : null}
              </span>
            ) : null}
          </div>
        </>
      )}
    </>
  );
}
