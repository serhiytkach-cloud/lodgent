import { describe, expect, it } from 'vitest';
import { destinationMatches, editDistance, haversineKm } from '../src/geo';
import { eligibility, type RankCandidate, type RankQuery, rankHotels } from '../src/ranking';

const room = (
  name: string,
  maxOccupancy: number | null,
  attributes: Record<string, boolean | number | string> = {},
) => ({
  id: `r-${name}`,
  name,
  maxOccupancy,
  attributes,
});

const hotel = (over: Partial<RankCandidate> & Pick<RankCandidate, 'hotelId' | 'name'>): RankCandidate => ({
  completeness: 50,
  attributes: {},
  rooms: [room('Double', 2)],
  similarity: null,
  ...over,
});

const sauna = { label: 'Sauna', codes: ['sauna'] };
const dogs = { label: 'Pets allowed', codes: ['pets_allowed', 'dogs_allowed'] };
const base: RankQuery = { mustHave: [], niceToHave: [], partySize: 2 };

describe('eligibility', () => {
  it('requires every must-have, at the hotel or in a room that fits the party', () => {
    const h = hotel({
      hotelId: 'a',
      name: 'A',
      attributes: { sauna: true },
      rooms: [room('Loft', 2, { bathtub: true })],
    });
    expect(eligibility(h, { ...base, mustHave: [sauna] })).toEqual({ ok: true });
    expect(eligibility(h, { ...base, mustHave: [{ label: 'Bathtub', codes: ['bathtub'] }] })).toEqual({
      ok: true,
    });
    expect(
      eligibility(h, { ...base, partySize: 3, mustHave: [{ label: 'Bathtub', codes: ['bathtub'] }] }),
    ).toMatchObject({
      ok: false,
    });
    expect(eligibility(h, { ...base, mustHave: [dogs] })).toEqual({
      ok: false,
      reason: 'missing Pets allowed',
    });
  });

  it('treats false and "none" as absent, honours enum values and alternatives', () => {
    const h = hotel({
      hotelId: 'a',
      name: 'A',
      attributes: { sauna: false, parking: 'paid', dogs_allowed: true },
    });
    expect(eligibility(h, { ...base, mustHave: [sauna] }).ok).toBe(false);
    expect(eligibility(h, { ...base, mustHave: [{ label: 'Parking', codes: ['parking'] }] }).ok).toBe(true);
    expect(
      eligibility(h, { ...base, mustHave: [{ label: 'Free parking', codes: ['parking'], value: 'free' }] })
        .ok,
    ).toBe(false);
    expect(eligibility(h, { ...base, mustHave: [dogs] }).ok).toBe(true);
    expect(
      eligibility(
        { ...h, attributes: { parking: 'none' } },
        { ...base, mustHave: [{ label: 'P', codes: ['parking'] }] },
      ).ok,
    ).toBe(false);
  });

  it('excludes hotels without capacity, sellable rooms or availability', () => {
    expect(eligibility(hotel({ hotelId: 'a', name: 'A' }), { ...base, partySize: 4 })).toMatchObject({
      ok: false,
    });
    expect(eligibility(hotel({ hotelId: 'a', name: 'A', rooms: [] }), base)).toMatchObject({ ok: false });
    expect(eligibility(hotel({ hotelId: 'a', name: 'A', price: null }), base)).toEqual({
      ok: false,
      reason: 'no availability for these dates',
    });
    // Unknown occupancy is not held against the hotel.
    expect(
      eligibility(hotel({ hotelId: 'a', name: 'A', rooms: [room('X', null)] }), { ...base, partySize: 5 }).ok,
    ).toBe(true);
  });
});

describe('rankHotels', () => {
  const price = (perNight: number) => ({ perNight, total: perNight * 2, nights: 2, currency: 'EUR' });

  it('is deterministic and explains itself', () => {
    const hotels = [
      hotel({
        hotelId: 'b',
        name: 'Beta',
        attributes: { sauna: true, spa: true },
        similarity: 0.7,
        price: price(18000),
      }),
      hotel({
        hotelId: 'a',
        name: 'Alpha',
        attributes: { sauna: true },
        similarity: 0.4,
        price: price(12000),
      }),
      hotel({ hotelId: 'c', name: 'Gamma', attributes: {}, similarity: 0.9, price: price(9000) }),
    ];
    const q: RankQuery = {
      ...base,
      mustHave: [sauna],
      niceToHave: [{ label: 'Spa', codes: ['spa'] }],
      budgetPerNight: { amount: 15000, currency: 'EUR' },
    };
    const first = rankHotels(hotels, q, { preferencesText: 'quiet alpine retreat' });
    const second = rankHotels([...hotels].reverse(), q, { preferencesText: 'quiet alpine retreat' });
    expect(first).toEqual(second);
    expect(first.excluded).toEqual([{ hotelId: 'c', reason: 'missing Sauna' }]);
    expect(first.ranked.map((r) => r.hotelId)).toEqual(['b', 'a']);
    const beta = first.ranked[0]!;
    expect(beta.matched).toEqual({ mustHave: ['sauna'], niceToHave: ['spa'], missingNiceToHave: [] });
    expect(beta.why).toEqual([
      'Has Sauna, confirmed by the hotel',
      'Strong match for “quiet alpine retreat”',
      'Also has Spa',
      'From €360.00 all-in for 2 nights (€180.00/night), above budget',
    ]);
    expect(beta.components.price).toBeCloseTo(0.6);
    expect(first.ranked[1]!.why).toContain('Doesn’t list Spa');
  });

  it('rewards the cheapest hotel when there is no budget, and breaks ties by price then name', () => {
    const { ranked } = rankHotels(
      [
        hotel({ hotelId: 'x', name: 'Zed', price: price(20000) }),
        hotel({ hotelId: 'y', name: 'Abe', price: price(10000) }),
        hotel({ hotelId: 'z', name: 'Bea', price: price(10000) }),
      ],
      base,
    );
    expect(ranked.map((r) => r.hotelId)).toEqual(['y', 'z', 'x']);
    expect(ranked[2]!.components.price).toBe(0.5);
  });

  it('scores on completeness alone without dates or preferences', () => {
    const { ranked } = rankHotels(
      [
        hotel({ hotelId: 'a', name: 'A', completeness: 30 }),
        hotel({ hotelId: 'b', name: 'B', completeness: 80 }),
      ],
      base,
    );
    expect(ranked.map((r) => [r.hotelId, r.score])).toEqual([
      ['b', 0.8],
      ['a', 0.3],
    ]);
  });
});

describe('geo', () => {
  it('measures distances', () => {
    expect(
      haversineKm({ latitude: 38.7223, longitude: -9.1393 }, { latitude: 41.1579, longitude: -8.6291 }),
    ).toBeCloseTo(274, -1);
    expect(editDistance('lisbon', 'lisboa')).toBe(1);
    expect(editDistance('seefled', 'seefeld')).toBe(1);
  });

  const lisbon = {
    city: 'Lisboa',
    region: null,
    countryCode: 'PT',
    countryName: 'Portugal',
    hotelName: 'Casa Azul Lisboa',
  };
  const charleston = {
    city: 'Charleston',
    region: 'SC',
    countryCode: 'US',
    countryName: 'United States',
    hotelName: 'The Marlowe',
  };
  const seefeld = {
    city: 'Seefeld in Tirol',
    region: null,
    countryCode: 'AT',
    countryName: 'Austria',
    hotelName: 'Berghaus',
  };

  it.each([
    ['Lisbon', lisbon, true],
    ['lisboa, portugal', lisbon, true],
    ['Portugal', lisbon, true],
    ['PT', lisbon, true],
    ['Porto', lisbon, false],
    ['Charleston SC', charleston, true],
    ['Charleston, USA', charleston, true],
    ['Charlotte', charleston, false],
    ['Seefeld', seefeld, true],
    ['Tyrol, Austria', seefeld, true],
    ['Innsbruck', seefeld, false],
    ['Casa Azul', lisbon, true],
  ])('%s matches %o: %s', (destination, place, expected) => {
    expect(destinationMatches(destination, place)).toBe(expected);
  });
});
