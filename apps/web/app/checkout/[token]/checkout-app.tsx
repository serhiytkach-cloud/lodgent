'use client';

import { BRAND, type CheckoutDto } from '@lodgent/shared';
import { CheckCircle2, Clock, Loader2, Lock, XCircle } from 'lucide-react';
import { type CSSProperties, type FormEvent, useCallback, useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/form';
import { Alert } from '@/components/ui/misc';
import { completeCheckout, refreshCheckout, startCheckout } from './actions';
import { SimulatedPayment, StripePayment } from './stripe-payment';

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const formatDate = (d: string) => dateFmt.format(new Date(`${d}T00:00:00Z`));

function guestsText(stay: CheckoutDto['stay']): string {
  const adults = `${stay.adults} adult${stay.adults === 1 ? '' : 's'}`;
  const kids = stay.childrenAges.length;
  return kids ? `${adults}, ${kids} child${kids === 1 ? '' : 'ren'}` : adults;
}

function safeColor(color: string | null): string {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color : '#1d4ed8';
}

function Countdown({ until, onExpired }: { until: string; onExpired: () => void }) {
  // Starts empty so server and client render the same markup; the clock fills in after mount.
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    setLeft(new Date(until).getTime() - Date.now());
    const t = setInterval(() => {
      const ms = new Date(until).getTime() - Date.now();
      setLeft(ms);
      if (ms <= 0) {
        clearInterval(t);
        onExpired();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [until, onExpired]);
  if (left === null) return <p className="h-5" />;
  const s = Math.max(0, Math.floor(left / 1000));
  const label = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return (
    <p
      className={`flex items-center gap-1.5 text-sm ${s < 120 ? 'text-destructive' : 'text-muted-foreground'}`}
      role="timer"
    >
      <Clock className="size-4" aria-hidden />
      Room held for <span className="font-medium tabular-nums">{label}</span>
    </p>
  );
}

function Summary({ c, compact = false }: { c: CheckoutDto; compact?: boolean }) {
  const row = (label: string, value: string, strong = false) => (
    <div className="flex justify-between gap-4 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={strong ? 'font-semibold tabular-nums' : 'tabular-nums'}>{value}</dd>
    </div>
  );
  return (
    <section className="grid gap-3 text-sm" aria-label="Your stay">
      <div>
        <p className="font-semibold">{c.stay.roomType}</p>
        <p className="text-muted-foreground">
          {c.stay.ratePlan}
          {c.stay.includes.length > 0 ? ` · includes ${c.stay.includes.join(', ')}` : ''}
        </p>
      </div>
      <dl className="grid">
        {row(
          'Check-in',
          `${formatDate(c.stay.checkIn)}${c.hotel.checkInTime ? `, from ${c.hotel.checkInTime}` : ''}`,
        )}
        {row(
          'Check-out',
          `${formatDate(c.stay.checkOut)}${c.hotel.checkOutTime ? `, until ${c.hotel.checkOutTime}` : ''}`,
        )}
        {row('Guests', `${guestsText(c.stay)} · ${c.stay.nights} night${c.stay.nights === 1 ? '' : 's'}`)}
      </dl>
      {compact ? null : (
        <dl className="grid border-t pt-2">
          {row('Room', c.price.accommodation.formatted)}
          {c.price.extras.map((e) => row(e.label, e.amount.formatted))}
          {c.price.includedTaxes.amount > 0 ? row('incl. VAT', c.price.includedTaxes.formatted) : null}
        </dl>
      )}
      <dl className="grid border-t pt-2">
        {row('Total', c.price.total.formatted, true)}
        {c.paymentMode === 'prepaid'
          ? row('Pay now', c.price.dueNow.formatted)
          : row('Pay at the hotel', c.price.dueAtHotel.formatted)}
      </dl>
      <p className="rounded-md bg-muted p-3 text-xs leading-relaxed">{c.cancellation}</p>
    </section>
  );
}

function GuestForm({
  token,
  c,
  onDone,
}: {
  token: string;
  c: CheckoutDto;
  onDone: (c: CheckoutDto) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await startCheckout(token, data);
      if (result.ok) {
        setError(null);
        setFieldErrors({});
        onDone(result.checkout);
      } else {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
      }
    });
  }
  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <h2 className="text-lg font-semibold">Your details</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="First name" htmlFor="firstName" error={fieldErrors.firstName}>
          <Input
            id="firstName"
            name="firstName"
            autoComplete="given-name"
            required
            defaultValue={c.guest?.firstName}
          />
        </Field>
        <Field label="Last name" htmlFor="lastName" error={fieldErrors.lastName}>
          <Input
            id="lastName"
            name="lastName"
            autoComplete="family-name"
            required
            defaultValue={c.guest?.lastName}
          />
        </Field>
      </div>
      <Field label="Email" htmlFor="email" hint="Your confirmation goes here." error={fieldErrors.email}>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          defaultValue={c.guest?.email}
        />
      </Field>
      <Field
        label="Phone (optional)"
        htmlFor="phone"
        hint="Only shared with the hotel."
        error={fieldErrors.phone}
      >
        <Input id="phone" name="phone" type="tel" autoComplete="tel" defaultValue={c.guest?.phone ?? ''} />
      </Field>
      <Field
        label="Requests for the hotel (optional)"
        htmlFor="specialRequests"
        error={fieldErrors.specialRequests}
      >
        <Textarea
          id="specialRequests"
          name="specialRequests"
          rows={2}
          maxLength={500}
          placeholder="e.g. late arrival, quiet room"
        />
      </Field>
      <p className="rounded-md bg-muted p-3 text-sm">
        <span className="font-medium">Cancellation: </span>
        {c.cancellation}
      </p>
      <label htmlFor="acceptTerms" className="flex items-start gap-3 text-sm">
        <Checkbox id="acceptTerms" name="acceptTerms" className="mt-0.5" required />
        <span>
          I accept the cancellation terms and hotel policies shown on this page. My details are shared with{' '}
          {c.hotel.name} for this booking only.
        </span>
      </label>
      {fieldErrors.acceptTerms ? (
        <p className="-mt-2 text-xs text-destructive">{fieldErrors.acceptTerms}</p>
      ) : null}
      {error && Object.keys(fieldErrors).length === 0 ? <Alert variant="error">{error}</Alert> : null}
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending
          ? 'Saving…'
          : c.paymentMode === 'prepaid'
            ? 'Continue to payment'
            : 'Continue to card guarantee'}
      </Button>
    </form>
  );
}

function StatusView({ c }: { c: CheckoutDto }) {
  if (c.status === 'confirmed') {
    return (
      <section className="grid gap-4 text-center" aria-live="polite">
        <CheckCircle2 className="mx-auto size-12 text-success" aria-hidden />
        <div>
          <h2 className="text-2xl font-semibold">You’re booked!</h2>
          <p className="mt-1 text-muted-foreground">
            A confirmation is on its way to {c.guest?.email ?? 'your inbox'}.
          </p>
        </div>
        <dl className="mx-auto grid w-full max-w-sm gap-1 rounded-lg border p-4 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Confirmation number</dt>
            <dd className="font-semibold">{c.booking?.confirmationNumber}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Reference</dt>
            <dd>{c.booking?.reference}</dd>
          </div>
        </dl>
        <p className="text-sm text-muted-foreground">
          {c.paymentMode === 'prepaid'
            ? `You paid ${c.price.dueNow.formatted}.`
            : `You pay ${c.price.dueAtHotel.formatted} at the hotel. Your card guarantees the booking.`}{' '}
          To change or cancel, contact the hotel
          {c.hotel.email ? (
            <>
              {' '}
              at{' '}
              <a className="underline" href={`mailto:${c.hotel.email}`}>
                {c.hotel.email}
              </a>
            </>
          ) : null}
          .
        </p>
      </section>
    );
  }
  if (c.status === 'processing') {
    return (
      <section className="grid gap-3 text-center" aria-live="polite">
        <Loader2 className="mx-auto size-10 animate-spin text-muted-foreground" aria-hidden />
        <p className="font-medium">{c.statusMessage}</p>
        <p className="text-sm text-muted-foreground">
          You can leave this page; we’ll email you the confirmation.
        </p>
      </section>
    );
  }
  return (
    <section className="grid gap-3 text-center" aria-live="polite">
      <XCircle className="mx-auto size-10 text-destructive" aria-hidden />
      <h2 className="text-xl font-semibold">
        {c.status === 'expired'
          ? 'This hold has expired'
          : c.status === 'cancelled'
            ? 'Booking cancelled'
            : 'Booking not completed'}
      </h2>
      <p className="text-sm text-muted-foreground">{c.statusMessage}</p>
    </section>
  );
}

export function CheckoutApp({
  token,
  initial,
  completeOnLoad,
}: {
  token: string;
  initial: CheckoutDto;
  completeOnLoad: boolean;
}) {
  const [c, setC] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const brand = safeColor(c.hotel.brandColor);

  const refresh = useCallback(() => {
    startTransition(async () => {
      const result = await refreshCheckout(token);
      if (result.ok) setC(result.checkout);
    });
  }, [token]);

  const complete = useCallback(() => {
    startTransition(async () => {
      const result = await completeCheckout(token);
      if (result.ok) setC(result.checkout);
      else setError(result.error);
    });
  }, [token]);

  // Returning from a redirect-based authentication (3-D Secure) lands here with ?complete=1.
  useEffect(() => {
    if (completeOnLoad && initial.status === 'awaiting_payment') complete();
  }, [completeOnLoad, initial.status, complete]);

  // While the reservation is being confirmed, poll.
  useEffect(() => {
    if (c.status !== 'processing') return;
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [c.status, refresh]);

  const open = c.status === 'open' || c.status === 'awaiting_payment';
  const payLabel = c.paymentMode === 'prepaid' ? `Pay ${c.price.dueNow.formatted}` : 'Guarantee with card';
  const returnUrl =
    typeof window === 'undefined' ? '' : `${window.location.origin}${window.location.pathname}?complete=1`;

  return (
    <div className="min-h-dvh bg-muted/40" style={{ '--brand': brand } as CSSProperties}>
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-4">
          {c.hotel.logoUrl ? (
            // biome-ignore lint/performance/noImgElement: hotel logos are arbitrary external URLs.
            <img src={c.hotel.logoUrl} alt="" className="h-9 w-auto max-w-32 object-contain" />
          ) : (
            <span
              className="grid size-9 place-items-center rounded-md font-semibold text-white"
              style={{ background: brand }}
            >
              {c.hotel.name.slice(0, 1)}
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate font-semibold">{c.hotel.name}</p>
            {c.hotel.address ? (
              <p className="truncate text-xs text-muted-foreground">{c.hotel.address}</p>
            ) : null}
          </div>
        </div>
        <div className="h-1" style={{ background: brand }} />
      </header>

      <main className="mx-auto grid max-w-5xl gap-6 px-4 py-6 md:grid-cols-[1fr_340px] md:py-10">
        <div className="grid content-start gap-6">
          {open ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h1 className="text-xl font-semibold tracking-tight">Complete your booking</h1>
              <Countdown until={c.expiresAt} onExpired={refresh} />
            </div>
          ) : null}

          <details className="rounded-xl border bg-card p-4 md:hidden">
            <summary className="flex cursor-pointer items-center justify-between gap-3 font-medium">
              <span className="min-w-0">
                <span className="block">Your stay</span>
                <span className="block truncate text-xs font-normal text-muted-foreground">
                  {formatDate(c.stay.checkIn)} – {formatDate(c.stay.checkOut)} · {guestsText(c.stay)}
                </span>
              </span>
              <span className="tabular-nums">{c.price.total.formatted}</span>
            </summary>
            <div className="mt-3">
              <Summary c={c} />
            </div>
          </details>

          <div className="rounded-xl border bg-card p-5 shadow-sm sm:p-6">
            {c.status === 'open' ? <GuestForm token={token} c={c} onDone={setC} /> : null}
            {c.status === 'awaiting_payment' && c.payment ? (
              <div className="grid gap-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold">
                    {c.paymentMode === 'prepaid' ? 'Payment' : 'Card guarantee'}
                  </h2>
                  <button
                    type="button"
                    className="text-sm underline"
                    onClick={() => setC({ ...c, status: 'open' })}
                  >
                    Edit details
                  </button>
                </div>
                <p className="text-sm text-muted-foreground">
                  {c.paymentMode === 'prepaid'
                    ? `${c.price.dueNow.formatted} is charged when the hotel confirms your reservation.`
                    : `Nothing is charged now. ${c.hotel.name} may charge the card for a late cancellation or no-show, as described in the terms.`}
                </p>
                {c.payment.simulatorUrl ? (
                  <SimulatedPayment payment={c.payment} label={payLabel} onSucceeded={complete} />
                ) : (
                  <StripePayment
                    payment={c.payment}
                    label={payLabel}
                    brandColor={c.hotel.brandColor}
                    returnUrl={returnUrl}
                    onSucceeded={complete}
                  />
                )}
                <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                  <Lock className="size-3.5" aria-hidden /> Secure payment by Stripe. Card details never reach{' '}
                  {BRAND.name}.
                </p>
              </div>
            ) : null}
            {!open ? <StatusView c={c} /> : null}
            {error ? (
              <Alert variant="error" className="mt-4">
                {error}
              </Alert>
            ) : null}
          </div>

          {c.policies.length > 0 ? (
            <section className="grid gap-2 text-sm">
              <h2 className="font-semibold">Hotel policies</h2>
              <dl className="grid gap-2">
                {c.policies.map((p) => (
                  <div key={p.title}>
                    <dt className="font-medium">{p.title}</dt>
                    {p.description ? <dd className="text-muted-foreground">{p.description}</dd> : null}
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
        </div>

        <aside className="hidden md:block">
          <div className="sticky top-6 rounded-xl border bg-card p-5 shadow-sm">
            <Summary c={c} />
          </div>
        </aside>
      </main>

      <footer className="pb-8 text-center text-xs text-muted-foreground">
        Booked directly with {c.hotel.name} via {BRAND.name}.{' '}
        <a className="underline" href={c.hotel.profileUrl}>
          About the hotel
        </a>
      </footer>
    </div>
  );
}
