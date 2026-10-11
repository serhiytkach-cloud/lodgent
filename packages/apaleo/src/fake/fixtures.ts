/**
 * Fixture data for the fake Apaleo server: three boutique hotels in one demo account plus a
 * second account for multi-tenant tests. Prices are major units, as Apaleo returns them.
 */

export interface FakeUnitGroup {
  id: string;
  code: string;
  name: string;
  description: string;
  maxPersons: number;
  memberCount: number;
  baseRate: number;
}

export interface FakeRatePlan {
  id: string;
  code: string;
  name: string;
  description: string;
  unitGroupId: string;
  minGuaranteeType: 'PM6Hold' | 'CreditCard' | 'Prepayment' | 'Company';
  channelCodes: string[];
  /** Multiplier on the unit group's base rate. */
  priceFactor: number;
  /** Per adult per night, included in the rate (e.g. breakfast). */
  includedServicePerPerson?: { code: string; name: string; description: string; amount: number };
  cancellation: {
    id: string;
    code: string;
    name: string;
    description: string;
    freeDaysBeforeArrival: number | null;
  };
}

export interface FakeProperty {
  id: string;
  code: string;
  name: string;
  description: string;
  location: {
    addressLine1: string;
    postalCode: string;
    city: string;
    regionCode?: string;
    countryCode: string;
  };
  timeZone: string;
  currencyCode: string;
  vatPercent: number;
  vatType: string;
  cityTax?: { name: string; perAdultPerNight?: number; percentOfRoom?: number; maxNights?: number };
  fee?: { code: string; name: string; perNight: number };
  unitGroups: FakeUnitGroup[];
  ratePlans: FakeRatePlan[];
}

export interface FakeAccount {
  code: string;
  name: string;
  properties: FakeProperty[];
}

const FLEX_2D = (prefix: string) => ({
  id: `${prefix}-CXL-FLEX`,
  code: 'FLEX48',
  name: 'Free cancellation until 2 days before arrival',
  description:
    'Cancel free of charge until 18:00 two days before arrival. Later cancellations are charged the first night.',
  freeDaysBeforeArrival: 2,
});

const NON_REF = (prefix: string) => ({
  id: `${prefix}-CXL-NRF`,
  code: 'NONREF',
  name: 'Non-refundable',
  description: 'Paid in full at booking. No refund on cancellation or no-show.',
  freeDaysBeforeArrival: null,
});

function plans(
  prefix: string,
  unitGroups: FakeUnitGroup[],
  breakfast?: { name: string; description: string; amount: number },
): FakeRatePlan[] {
  return unitGroups.flatMap((ug) => {
    const list: FakeRatePlan[] = [
      {
        id: `${ug.id}-FLEX`,
        code: 'FLEX',
        name: 'Flexible rate',
        description: 'Pay at the hotel. Free cancellation until two days before arrival.',
        unitGroupId: ug.id,
        minGuaranteeType: 'CreditCard',
        channelCodes: ['Direct', 'Ibe', 'BookingCom'],
        priceFactor: 1,
        cancellation: FLEX_2D(prefix),
      },
      {
        id: `${ug.id}-NRF`,
        code: 'NRF',
        name: 'Non-refundable saver',
        description: 'Best price, paid in full when you book. Non-refundable.',
        unitGroupId: ug.id,
        minGuaranteeType: 'Prepayment',
        channelCodes: ['Direct', 'Ibe'],
        priceFactor: 0.88,
        cancellation: NON_REF(prefix),
      },
    ];
    if (breakfast) {
      list.push({
        id: `${ug.id}-BB`,
        code: 'BB',
        name: 'Bed & breakfast',
        description: `Flexible rate including ${breakfast.name.toLowerCase()}.`,
        unitGroupId: ug.id,
        minGuaranteeType: 'CreditCard',
        channelCodes: ['Direct', 'Ibe'],
        priceFactor: 1,
        includedServicePerPerson: { code: 'BRKF', ...breakfast },
        cancellation: FLEX_2D(prefix),
      });
    }
    // A corporate rate that must never be exposed to agents.
    list.push({
      id: `${ug.id}-CORP`,
      code: 'CORP',
      name: 'Corporate rate',
      description: 'Negotiated company rate.',
      unitGroupId: ug.id,
      minGuaranteeType: 'Company',
      channelCodes: ['Direct'],
      priceFactor: 0.8,
      cancellation: FLEX_2D(prefix),
    });
    return list;
  });
}

const lisbonUnits: FakeUnitGroup[] = [
  {
    id: 'LIS-CLS',
    code: 'CLS',
    name: 'Classic Double',
    description: '18 m² double room facing the tiled courtyard, queen bed, rain shower.',
    maxPersons: 2,
    memberCount: 12,
    baseRate: 145,
  },
  {
    id: 'LIS-DLX',
    code: 'DLX',
    name: 'Deluxe River View',
    description: '26 m² room with a French balcony over the Tagus, king bed, bathtub, Nespresso machine.',
    maxPersons: 3,
    memberCount: 8,
    baseRate: 210,
  },
  {
    id: 'LIS-SUI',
    code: 'SUI',
    name: 'Azulejo Suite',
    description:
      '42 m² suite with original 19th-century tiles, separate living room and sofa bed, river views.',
    maxPersons: 4,
    memberCount: 4,
    baseRate: 320,
  },
];

const tyrolUnits: FakeUnitGroup[] = [
  {
    id: 'SEE-DBL',
    code: 'DBL',
    name: 'Alpine Double',
    description: '24 m² larch-wood room with mountain-view balcony and down duvets.',
    maxPersons: 2,
    memberCount: 10,
    baseRate: 180,
  },
  {
    id: 'SEE-FAM',
    code: 'FAM',
    name: 'Family Room',
    description: '38 m² room with a double bed and bunk-bed alcove for two children, balcony.',
    maxPersons: 4,
    memberCount: 6,
    baseRate: 260,
  },
  {
    id: 'SEE-LOFT',
    code: 'LOFT',
    name: 'Larch Loft',
    description: '45 m² top-floor loft with private infrared sauna and panoramic window.',
    maxPersons: 2,
    memberCount: 2,
    baseRate: 340,
  },
];

const charlestonUnits: FakeUnitGroup[] = [
  {
    id: 'CHS-KNG',
    code: 'KNG',
    name: 'King Room',
    description: '300 sq ft room with king bed, heart-pine floors and walk-in shower.',
    maxPersons: 2,
    memberCount: 16,
    baseRate: 289,
  },
  {
    id: 'CHS-QQ',
    code: 'QQ',
    name: 'Double Queen',
    description: '380 sq ft room with two queen beds, ideal for families.',
    maxPersons: 4,
    memberCount: 12,
    baseRate: 319,
  },
  {
    id: 'CHS-PIAZ',
    code: 'PIAZ',
    name: 'Piazza Suite',
    description: '550 sq ft suite with a private porch over the courtyard garden and a soaking tub.',
    maxPersons: 3,
    memberCount: 4,
    baseRate: 459,
  },
];

export const FAKE_ACCOUNTS: FakeAccount[] = [
  {
    code: 'DEMO',
    name: 'Demo Boutique Hotels',
    properties: [
      {
        id: 'LIS',
        code: 'LIS',
        name: 'Casa Azul Lisboa',
        description:
          'A restored 19th-century townhouse in Lapa with 24 rooms, an azulejo-tiled courtyard and views over the Tagus.',
        location: {
          addressLine1: 'Rua das Janelas Verdes 32',
          postalCode: '1200-691',
          city: 'Lisboa',
          countryCode: 'PT',
        },
        timeZone: 'Europe/Lisbon',
        currencyCode: 'EUR',
        vatPercent: 6,
        vatType: 'Reduced',
        cityTax: { name: 'Lisbon tourist tax', perAdultPerNight: 4, maxNights: 7 },
        unitGroups: lisbonUnits,
        ratePlans: plans('LIS', lisbonUnits, {
          name: 'Breakfast',
          description: 'Portuguese breakfast buffet with pastéis de nata',
          amount: 14,
        }),
      },
      {
        id: 'SEE',
        code: 'SEE',
        name: 'Berghaus Lärche',
        description:
          'An 18-room alpine hideaway in Seefeld with a larch-wood spa, ski room and direct access to the cross-country trails.',
        location: {
          addressLine1: 'Möserer Straße 12',
          postalCode: '6100',
          city: 'Seefeld in Tirol',
          countryCode: 'AT',
        },
        timeZone: 'Europe/Vienna',
        currencyCode: 'EUR',
        vatPercent: 10,
        vatType: 'Reduced',
        cityTax: { name: 'Aufenthaltsabgabe (local tourist tax)', perAdultPerNight: 3.5 },
        unitGroups: tyrolUnits,
        ratePlans: plans('SEE', tyrolUnits, {
          name: 'Half board',
          description: 'Alpine breakfast and four-course dinner',
          amount: 45,
        }),
      },
      {
        id: 'CHS',
        code: 'CHS',
        name: 'The Marlowe Charleston',
        description:
          'A 32-room boutique inn in a restored 1840s cotton exchange in Charleston’s French Quarter, with a courtyard garden and rooftop bar.',
        location: {
          addressLine1: '14 Queen Street',
          postalCode: '29401',
          city: 'Charleston',
          regionCode: 'SC',
          countryCode: 'US',
        },
        timeZone: 'America/New_York',
        currencyCode: 'USD',
        vatPercent: 0,
        vatType: 'Without',
        cityTax: { name: 'State & local accommodations tax', percentOfRoom: 13.5 },
        fee: { code: 'DEST', name: 'Destination fee', perNight: 30 },
        unitGroups: charlestonUnits,
        ratePlans: plans('CHS', charlestonUnits),
      },
    ],
  },
  {
    code: 'OTHR',
    name: 'Other Hotel Group',
    properties: [
      {
        id: 'OTH',
        code: 'OTH',
        name: 'Hotel Otherside',
        description: 'A test hotel in a different Apaleo account.',
        location: { addressLine1: 'Teststraße 1', postalCode: '10115', city: 'Berlin', countryCode: 'DE' },
        timeZone: 'Europe/Berlin',
        currencyCode: 'EUR',
        vatPercent: 7,
        vatType: 'Reduced',
        unitGroups: [
          {
            id: 'OTH-DBL',
            code: 'DBL',
            name: 'Double',
            description: 'Standard double room.',
            maxPersons: 2,
            memberCount: 5,
            baseRate: 99,
          },
        ],
        ratePlans: [],
      },
    ],
  },
];

FAKE_ACCOUNTS[1]!.properties[0]!.ratePlans = plans('OTH', FAKE_ACCOUNTS[1]!.properties[0]!.unitGroups);
