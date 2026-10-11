/**
 * schema.org JSON-LD for a published hotel (Hotel, HotelRoom, Offer, LocationFeatureSpecification).
 * The hotel embeds this on its own website; our public profile page embeds it too.
 */

export interface JsonLdAttribute {
  code: string;
  label: string;
  value: boolean | number | string;
  schemaOrg:
    | { property: 'amenityFeature' }
    | { property: 'petsAllowed' }
    | { property: 'smokingAllowed'; invert: true };
}

export interface JsonLdInput {
  profileUrl: string;
  bookingUrl: string;
  name: string;
  description: string | null;
  websiteUrl: string | null;
  email: string | null;
  phone: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    postalCode: string | null;
    region: string | null;
    countryCode: string | null;
  };
  latitude: number | null;
  longitude: number | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  currency: string;
  photos: { url: string; caption?: string }[];
  logoUrl: string | null;
  attributes: JsonLdAttribute[];
  rooms: {
    id: string;
    name: string;
    description: string | null;
    maxOccupancy: number | null;
    sizeSqm: number | null;
    attributes: JsonLdAttribute[];
    ratePlans: { name: string; description: string | null }[];
  }[];
}

type Json = Record<string, unknown>;

function amenityFeatures(attributes: JsonLdAttribute[]): Json[] {
  return attributes
    .filter((a) => a.schemaOrg.property === 'amenityFeature' && a.value !== false && a.value !== 'none')
    .map((a) => ({
      '@type': 'LocationFeatureSpecification',
      name: a.label,
      value: typeof a.value === 'boolean' ? true : a.value,
    }));
}

/** Removes null, undefined and empty arrays so the snippet stays clean. */
function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compact).filter((v) => v !== undefined) as T;
  if (value && typeof value === 'object') {
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) continue;
      out[k] = compact(v);
    }
    return out as T;
  }
  return value;
}

export function hotelJsonLd(input: JsonLdInput): Json {
  const pets = input.attributes.find((a) => a.schemaOrg.property === 'petsAllowed');
  const nonSmoking = input.attributes.find((a) => a.schemaOrg.property === 'smokingAllowed');
  const hotelId = `${input.profileUrl}#hotel`;
  return compact({
    '@context': 'https://schema.org',
    '@type': 'Hotel',
    '@id': hotelId,
    name: input.name,
    description: input.description,
    url: input.websiteUrl ?? input.profileUrl,
    sameAs: input.websiteUrl ? [input.profileUrl] : null,
    email: input.email,
    telephone: input.phone,
    logo: input.logoUrl,
    image: input.photos.map((p) => p.url),
    address: {
      '@type': 'PostalAddress',
      streetAddress: [input.address.line1, input.address.line2].filter(Boolean).join(', ') || null,
      addressLocality: input.address.city,
      postalCode: input.address.postalCode,
      addressRegion: input.address.region,
      addressCountry: input.address.countryCode,
    },
    geo:
      input.latitude !== null && input.longitude !== null
        ? { '@type': 'GeoCoordinates', latitude: input.latitude, longitude: input.longitude }
        : null,
    checkinTime: input.checkInTime,
    checkoutTime: input.checkOutTime,
    currenciesAccepted: input.currency,
    petsAllowed: pets ? pets.value === true : null,
    smokingAllowed: nonSmoking ? nonSmoking.value !== true : null,
    amenityFeature: amenityFeatures(input.attributes),
    containsPlace: input.rooms.map((room) => ({
      '@type': 'HotelRoom',
      '@id': `${input.profileUrl}#room-${room.id}`,
      name: room.name,
      description: room.description,
      occupancy: room.maxOccupancy ? { '@type': 'QuantitativeValue', maxValue: room.maxOccupancy } : null,
      floorSize: room.sizeSqm ? { '@type': 'QuantitativeValue', value: room.sizeSqm, unitCode: 'MTK' } : null,
      amenityFeature: amenityFeatures(room.attributes),
    })),
    makesOffer: input.rooms.flatMap((room) =>
      room.ratePlans.map((rp) => ({
        '@type': 'Offer',
        name: `${room.name}: ${rp.name}`,
        description: rp.description,
        priceCurrency: input.currency,
        url: input.bookingUrl,
        itemOffered: { '@id': `${input.profileUrl}#room-${room.id}` },
      })),
    ),
    potentialAction: {
      '@type': 'ReserveAction',
      target: { '@type': 'EntryPoint', urlTemplate: input.bookingUrl },
    },
  });
}
