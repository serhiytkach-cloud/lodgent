import { describe, expect, it } from 'vitest';
import { analyzeAnswer, nameVariants, suggestQueries, visibilityRecommendations } from '../src/visibility';

const target = {
  name: 'Casa Azul Lisboa',
  city: 'Lisboa',
  ownDomains: ['casaazul.example'],
  profileDomains: ['lodgent.example'],
};

describe('nameVariants', () => {
  it('drops generic words and the city, but never goes too short', () => {
    expect(nameVariants('Casa Azul Lisboa', 'Lisboa')).toEqual(['casa azul lisboa', 'casa azul']);
    expect(nameVariants('The Marlowe Charleston', 'Charleston')).toEqual([
      'the marlowe charleston',
      'marlowe charleston',
      'marlowe',
    ]);
    expect(nameVariants('Hotel Lux', 'Rome')).toEqual(['hotel lux']);
  });
});

describe('analyzeAnswer', () => {
  it('finds the rank in a numbered list, competitors and citations', () => {
    const answer = `Here are great boutique options in Lisbon:

1. **Memmo Alfama** – rooftop pool with views.
2. **Casa Azul Lisboa** - a restored townhouse in Lapa with river views.
3. **The Lumiares** (Bairro Alto): apartments-style suites.

Book early for summer.`;
    const result = analyzeAnswer({
      answer,
      citations: [
        { url: 'https://www.casaazul.example/rooms', title: 'Rooms' },
        { url: 'https://tripadvisor.com/x' },
      ],
      target,
    });
    expect(result).toMatchObject({
      mentioned: true,
      rank: 2,
      listSize: 3,
      competitors: ['Memmo Alfama', 'The Lumiares'],
      ownSiteCited: true,
      profileCited: false,
    });
    expect(result.excerpt).toContain('Casa Azul Lisboa');
  });

  it('handles prose mentions, accents and bullet lists', () => {
    const prose = analyzeAnswer({
      answer: 'For river views, travellers love CASA AZUL in Lapa, near the museum.',
      citations: [],
      target,
    });
    expect(prose).toMatchObject({ mentioned: true, rank: null, listSize: 0 });

    const bullets = analyzeAnswer({
      answer: '- Berghaus Lärche: spa\n- Hotel Seefelderhof: central\n- Larch Loft Inn',
      citations: [{ url: 'https://lodgent.example/hotels/berghaus' }],
      target: {
        name: 'Berghaus Larche',
        city: 'Seefeld in Tirol',
        ownDomains: [],
        profileDomains: ['lodgent.example'],
      },
    });
    expect(bullets).toMatchObject({
      mentioned: true,
      rank: 1,
      profileCited: true,
      competitors: ['Hotel Seefelderhof', 'Larch Loft Inn'],
    });
  });

  it('does not invent a mention', () => {
    const r = analyzeAnswer({
      answer: '1. **Azul Hostel** – budget\n2. **Lisboa Plaza** – classic',
      citations: [],
      target,
    });
    expect(r).toMatchObject({ mentioned: false, rank: null, listSize: 2 });
  });
});

describe('suggestQueries', () => {
  it('builds questions from location and the most important confirmed features', () => {
    expect(
      suggestQueries({
        city: 'Seefeld',
        region: null,
        attributes: [
          { code: 'spa', label: 'Spa', importance: 5 },
          { code: 'pets_allowed', label: 'Pets allowed', importance: 5 },
          { code: 'sauna', label: 'Sauna', importance: 4 },
        ],
      }),
    ).toEqual([
      'best boutique hotels in Seefeld',
      'dog-friendly hotels in Seefeld',
      'hotels with a spa in Seefeld',
      'hotels with a sauna in Seefeld',
      'where to stay in Seefeld',
      'best hotels in Seefeld for a weekend',
    ]);
    expect(suggestQueries({ city: null, region: null, attributes: [] })).toEqual([]);
  });
});

describe('visibilityRecommendations', () => {
  it('suggests the structured data when no assistant cites the site, and names frequent competitors', () => {
    const recs = visibilityRecommendations({
      published: true,
      websiteUrl: 'https://casaazul.example',
      completeness: 55,
      topGaps: ['Map location', 'Air conditioning'],
      results: [
        {
          mentioned: false,
          ownSiteCited: false,
          profileCited: false,
          competitors: ['Memmo Alfama', 'The Lumiares'],
        },
        { mentioned: false, ownSiteCited: false, profileCited: false, competitors: ['Memmo Alfama'] },
      ],
    });
    expect(recs.map((r) => r.key)).toEqual(['jsonld', 'complete', 'competitors']);
    expect(recs[2]!.detail).toMatch(/^Memmo Alfama, The Lumiares/);
  });
});
