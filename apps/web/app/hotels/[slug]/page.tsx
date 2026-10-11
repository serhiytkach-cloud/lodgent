import type { HotelProfileDto } from '@lodgent/shared';
import { BRAND } from '@lodgent/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { Badge } from '@/components/ui/misc';
import { ApiError, api } from '@/lib/api';

const CATEGORY_LABELS: Record<string, string> = {
  location: 'Location & setting',
  room: 'Rooms',
  amenities: 'Amenities',
  food: 'Food & drink',
  wellness: 'Wellness',
  accessibility: 'Accessibility',
  family: 'Families',
  pets: 'Pets',
  work: 'Work',
  sustainability: 'Sustainability',
  style: 'Style',
};

const load = cache(async (slug: string) => {
  try {
    return await api<{ profile: HotelProfileDto; jsonLd: Record<string, unknown> }>(
      `/v1/public/hotels/${encodeURIComponent(slug)}`,
      { token: null },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
});

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { profile } = await load((await params).slug);
  return {
    title: `${profile.name} — ${[profile.address.city, profile.address.countryCode].filter(Boolean).join(', ')}`,
    description: profile.description ?? undefined,
    alternates: { canonical: profile.profileUrl },
  };
}

/** "Free Wi-Fi" for yes/no facts, "Room size: 42 m²" for values. */
function fact(a: { label: string; value: boolean | number | string; display: string }): string {
  return typeof a.value === 'boolean' ? a.label : `${a.label}: ${a.display}`;
}

export default async function HotelProfilePage({ params }: { params: Promise<{ slug: string }> }) {
  const { profile, jsonLd } = await load((await params).slug);
  const facts = profile.attributes.filter((a) => a.value !== false);
  const negatives = profile.attributes.filter((a) => a.value === false);
  const categories = [...new Set(facts.map((a) => a.category))];
  const address = [
    profile.address.line1,
    [profile.address.postalCode, profile.address.city].filter(Boolean).join(' '),
    profile.address.region,
    profile.address.countryCode,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD must be inline; "<" is escaped below.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />
      <header className="grid gap-2">
        <p className="text-sm text-muted-foreground">{address}</p>
        <h1 className="text-3xl font-semibold tracking-tight">{profile.name}</h1>
        {profile.description ? <p className="text-base leading-relaxed">{profile.description}</p> : null}
        <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
          {profile.checkInTime ? <span>Check-in from {profile.checkInTime}</span> : null}
          {profile.checkOutTime ? <span>Check-out until {profile.checkOutTime}</span> : null}
          {profile.website ? (
            <a href={profile.website} rel="noopener noreferrer" className="underline underline-offset-2">
              Hotel website
            </a>
          ) : null}
        </div>
      </header>

      {facts.length > 0 ? (
        <section className="mt-10 grid gap-5" aria-labelledby="facts">
          <h2 id="facts" className="text-xl font-semibold">
            At a glance
          </h2>
          {categories.map((c) => (
            <div key={c}>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {CATEGORY_LABELS[c] ?? c}
              </h3>
              <ul className="flex flex-wrap gap-2">
                {facts
                  .filter((a) => a.category === c)
                  .map((a) => (
                    <li key={a.code}>
                      <Badge variant="secondary" className="text-sm font-normal">
                        {fact(a)}
                      </Badge>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
          {negatives.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              Not available: {negatives.map((a) => a.label).join(', ')}.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="mt-10 grid gap-4" aria-labelledby="rooms">
        <h2 id="rooms" className="text-xl font-semibold">
          Rooms
        </h2>
        {profile.roomTypes.map((room) => (
          <article key={room.id} className="rounded-xl border bg-card p-4 shadow-sm">
            <h3 className="font-semibold">{room.name}</h3>
            {room.description ? <p className="mt-1 text-sm">{room.description}</p> : null}
            <p className="mt-1 text-xs text-muted-foreground">
              {room.maxOccupancy ? `Up to ${room.maxOccupancy} guests` : null}
            </p>
            {room.attributes.length > 0 ? (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {room.attributes
                  .filter((a) => a.value !== false)
                  .map((a) => (
                    <li key={a.code}>
                      <Badge variant="outline">{fact(a)}</Badge>
                    </li>
                  ))}
              </ul>
            ) : null}
            <ul className="mt-3 grid gap-1 text-sm">
              {room.ratePlans.map((rp) => (
                <li key={rp.id} className="flex flex-wrap gap-x-2">
                  <span className="font-medium">{rp.name}</span>
                  <span className="text-muted-foreground">
                    {rp.paymentMode === 'prepaid' ? 'Pay now' : 'Pay at the hotel'}
                    {rp.includes.length > 0 ? ` · includes ${rp.includes.join(', ')}` : ''}
                    {rp.cancellationPolicy ? ` · ${rp.cancellationPolicy}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>

      {profile.policies.length > 0 ? (
        <section className="mt-10 grid gap-3" aria-labelledby="policies">
          <h2 id="policies" className="text-xl font-semibold">
            Policies
          </h2>
          <dl className="grid gap-3 text-sm">
            {profile.policies.map((p) => (
              <div key={`${p.kind}-${p.title}`}>
                <dt className="font-medium">{p.title}</dt>
                {p.description ? <dd className="text-muted-foreground">{p.description}</dd> : null}
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <footer className="mt-14 border-t pt-4 text-xs text-muted-foreground">
        Live rates and booking for AI assistants via {BRAND.name}. Facts on this page are confirmed by the
        hotel.
      </footer>
    </main>
  );
}
