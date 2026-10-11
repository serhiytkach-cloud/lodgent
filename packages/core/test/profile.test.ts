import { describe, expect, it } from 'vitest';
import {
  completeness,
  effectiveAssignments,
  evidenceAppearsIn,
  hotelJsonLd,
  mapPmsToAttributes,
  scopeKey,
} from '../src';

const t = (iso: string) => new Date(iso);

describe('effective assignments', () => {
  it('uses the latest approved value and ignores suggestions', () => {
    const base = { roomTypeId: null, attributeCode: 'parking', updatedAt: t('2026-01-01') };
    const map = effectiveAssignments([
      {
        ...base,
        id: '1',
        value: 'free',
        source: 'pms' as const,
        status: 'approved' as const,
        reviewedAt: t('2026-01-02'),
      },
      {
        ...base,
        id: '2',
        value: 'paid',
        source: 'website' as const,
        status: 'approved' as const,
        reviewedAt: t('2026-01-03'),
      },
      {
        ...base,
        id: '3',
        value: 'valet',
        source: 'ai_extracted' as const,
        status: 'suggested' as const,
        reviewedAt: null,
      },
    ]);
    expect(map.get(scopeKey(null, 'parking'))?.id).toBe('2');
  });

  it('lets the hotel win a tie', () => {
    const at = t('2026-01-02');
    const base = {
      roomTypeId: 'r1',
      attributeCode: 'balcony',
      updatedAt: at,
      reviewedAt: at,
      status: 'approved' as const,
    };
    const map = effectiveAssignments([
      { ...base, id: 'a', value: true, source: 'pms' as const },
      { ...base, id: 'b', value: false, source: 'hotel' as const },
    ]);
    expect(map.get(scopeKey('r1', 'balcony'))?.id).toBe('b');
  });
});

describe('evidence verification', () => {
  const page =
    'Our 24 rooms surround an azulejo-tiled courtyard.  Free Wi‑Fi throughout. Dogs welcome on request!';
  it('accepts verbatim quotes regardless of case and whitespace', () => {
    expect(evidenceAppearsIn('free wi‑fi throughout', page)).toBe(true);
    expect(evidenceAppearsIn('24 rooms surround … Dogs welcome', page)).toBe(true);
  });
  it('rejects invented quotes', () => {
    expect(evidenceAppearsIn('rooftop pool with city views', page)).toBe(false);
    expect(evidenceAppearsIn('', page)).toBe(false);
  });
});

describe('completeness', () => {
  it('scores basics and important attributes and ranks the gaps', () => {
    const result = completeness({
      description: 'A'.repeat(100),
      photos: 0,
      hasCoordinates: true,
      hasCheckInOut: true,
      websiteUrl: null,
      roomTypes: [{ name: 'Double', description: 'A lovely 20 m² double room with a view.' }],
      exposedRatePlans: 1,
      attributes: [
        { code: 'parking', label: 'Parking', importance: 5, appliesTo: 'property' },
        { code: 'yoga', label: 'Yoga classes', importance: 2, appliesTo: 'property' },
        { code: 'sauna', label: 'Sauna', importance: 4, appliesTo: 'property' },
        { code: 'balcony', label: 'Balcony', importance: 4, appliesTo: 'room' },
      ],
      answeredCodes: new Set(['sauna']),
    });
    expect(result.gaps[0]).toMatchObject({ key: 'attr:parking' });
    expect(result.gaps[0]?.message).toMatch(/Agents often filter on “parking”/);
    expect(result.gaps.map((g) => g.key)).toContain('photos');
    expect(result.gaps.map((g) => g.key)).not.toContain('attr:yoga');
    expect(result.score).toBeGreaterThan(70);
    expect(result.score).toBeLessThan(100);
  });
});

describe('PMS mapping', () => {
  it('derives breakfast, room size and room features from PMS data', () => {
    const mapped = mapPmsToAttributes({
      propertyPmsId: 'LIS',
      ratePlans: [
        {
          pmsId: 'LIS-DLX-BB',
          name: 'Bed & breakfast',
          minGuarantee: 'credit_card',
          includedServices: [{ name: 'Breakfast', description: null }],
          cancellationTitle: null,
        },
      ],
      roomTypes: [
        {
          id: 'room-1',
          pmsId: 'LIS-DLX',
          name: 'Deluxe River View',
          description:
            '26 m² room with a French balcony over the Tagus, king bed, bathtub, Nespresso machine.',
          maxOccupancy: 3,
        },
      ],
    });
    const codes = mapped.map((m) => `${m.roomTypeId ?? 'property'}:${m.code}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        'property:breakfast_available',
        'room-1:room_size_sqm',
        'room-1:balcony',
        'room-1:king_bed',
        'room-1:bathtub',
        'room-1:coffee_machine',
        'room-1:river_view',
      ]),
    );
    expect(mapped.find((m) => m.code === 'room_size_sqm')?.value).toBe(26);
    expect(mapped.every((m) => m.evidence.url.startsWith('pms://apaleo/'))).toBe(true);
  });
});

describe('JSON-LD', () => {
  it('describes the hotel, rooms, offers and amenities', () => {
    const doc = hotelJsonLd({
      profileUrl: 'https://lodgent.example/hotels/casa-azul',
      bookingUrl: 'https://lodgent.example/hotels/casa-azul#book',
      name: 'Casa Azul',
      description: 'Townhouse hotel',
      websiteUrl: 'https://casa-azul.example',
      email: null,
      phone: null,
      address: {
        line1: 'Rua 1',
        line2: null,
        city: 'Lisboa',
        postalCode: '1200',
        region: null,
        countryCode: 'PT',
      },
      latitude: 38.7,
      longitude: -9.16,
      checkInTime: '15:00',
      checkOutTime: '11:00',
      currency: 'EUR',
      photos: [],
      logoUrl: null,
      attributes: [
        { code: 'free_wifi', label: 'Free Wi-Fi', value: true, schemaOrg: { property: 'amenityFeature' } },
        { code: 'spa', label: 'Spa', value: false, schemaOrg: { property: 'amenityFeature' } },
        { code: 'pets_allowed', label: 'Pets allowed', value: true, schemaOrg: { property: 'petsAllowed' } },
      ],
      rooms: [
        {
          id: 'r1',
          name: 'Deluxe',
          description: null,
          maxOccupancy: 3,
          sizeSqm: 26,
          attributes: [
            { code: 'balcony', label: 'Balcony', value: true, schemaOrg: { property: 'amenityFeature' } },
          ],
          ratePlans: [{ name: 'Flexible rate', description: null }],
        },
      ],
    });
    expect(doc['@type']).toBe('Hotel');
    expect(doc.petsAllowed).toBe(true);
    expect(doc.amenityFeature).toEqual([
      { '@type': 'LocationFeatureSpecification', name: 'Free Wi-Fi', value: true },
    ]);
    expect((doc.containsPlace as { floorSize: { value: number } }[])[0]?.floorSize.value).toBe(26);
    expect((doc.makesOffer as unknown[]).length).toBe(1);
    expect(JSON.stringify(doc)).not.toContain('null');
  });
});
