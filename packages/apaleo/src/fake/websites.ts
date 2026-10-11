/**
 * Demo hotel websites served by the fake server under `/sites/:site/…`, so website import can be
 * exercised locally without touching the internet. Each site has the kinds of pages a real
 * boutique-hotel site has (rooms, amenities, dining, policies, location), plus a link that
 * robots.txt disallows and an off-site link, both of which the crawler must skip.
 */

export interface FakeSitePage {
  path: string;
  title: string;
  body: string;
}

export interface FakeSite {
  code: string;
  name: string;
  pages: FakeSitePage[];
  jsonLd?: Record<string, unknown>;
}

const nav = (site: string, pages: FakeSitePage[]) =>
  `<nav><ul>${pages
    .map((p) => `<li><a href="/sites/${site}${p.path}">${p.title.split(' · ')[0]}</a></li>`)
    .join(
      '',
    )}<li><a href="/sites/${site}/admin/">Staff</a></li><li><a href="https://www.instagram.com/example">Instagram</a></li></ul></nav>`;

export const FAKE_SITES: FakeSite[] = [
  {
    code: 'lis',
    name: 'Casa Azul Lisboa',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Hotel',
      name: 'Casa Azul Lisboa',
      address: {
        '@type': 'PostalAddress',
        streetAddress: 'Rua das Janelas Verdes 32',
        addressLocality: 'Lisboa',
      },
    },
    pages: [
      {
        path: '/',
        title: 'Home · Casa Azul Lisboa',
        body: `
          <h1>Casa Azul Lisboa</h1>
          <p>Casa Azul is a boutique hotel in a restored 19th-century townhouse in Lapa, one of Lisbon's quietest and most elegant neighbourhoods. Our 24 rooms open onto an azulejo-tiled courtyard or look out over the Tagus.</p>
          <p>Mornings start with a Portuguese breakfast buffet in the courtyard; evenings end in the honesty bar with a glass of port. We are a short tram ride from Baixa and within walking distance of the Museu Nacional de Arte Antiga.</p>
          <p>Free Wi-Fi is available throughout the house.</p>`,
      },
      {
        path: '/rooms/',
        title: 'Rooms & suites · Casa Azul Lisboa',
        body: `
          <h1>Rooms &amp; suites</h1>
          <h2>Classic Double</h2>
          <p>The Classic Double is 18 m² and faces the tiled courtyard, with a queen bed and a rain shower.</p>
          <h2>Deluxe River View</h2>
          <p>Every Deluxe River View room measures 26 m² and has a French balcony over the Tagus, a king bed, a bathtub and a Nespresso machine.</p>
          <h2>Azulejo Suite</h2>
          <p>The Azulejo Suite is 42 m² with original tiles, a separate living room with a sofa bed and river views.</p>
          <h2>In every room</h2>
          <ul>
            <li>All rooms are air-conditioned and have blackout curtains.</li>
            <li>Organic toiletries, bathrobes and a hairdryer.</li>
            <li>Smart TV with Chromecast.</li>
          </ul>`,
      },
      {
        path: '/amenities/',
        title: 'Amenities · Casa Azul Lisboa',
        body: `
          <h1>Amenities</h1>
          <ul>
            <li>24-hour reception and concierge.</li>
            <li>Luggage storage before check-in and after check-out.</li>
            <li>A lift serves all four floors.</li>
            <li>Bike rental with e-bikes for the hills of Lisbon.</li>
            <li>Paid parking is available in the public garage 200 metres away for €25 per day.</li>
            <li>Guide dogs and assistance dogs are always welcome.</li>
            <li>Late check-out until 14:00 on request.</li>
          </ul>
          <h2>Breakfast</h2>
          <p>Breakfast is served from 7:30 to 11:00, with vegetarian and gluten-free options on request.</p>`,
      },
      {
        path: '/sustainability/',
        title: 'Sustainability · Casa Azul Lisboa',
        body: `
          <h1>Sustainability</h1>
          <p>We hold the Green Key certification since 2023.</p>
          <p>Our bathrooms use refillable dispensers and we have removed single-use plastic from the house.</p>`,
      },
      {
        path: '/location/',
        title: 'Location · Casa Azul Lisboa',
        body: `
          <h1>Getting here</h1>
          <p>The tram stop for line 15 is two minutes from the door; Santos train station is a ten-minute walk.</p>
          <p>Lapa is a quiet neighbourhood of embassies and gardens, a stroll to the riverside cafés of Santos.</p>
          <address>Rua das Janelas Verdes 32, 1200-691 Lisboa, Portugal</address>`,
      },
    ],
  },
  {
    code: 'see',
    name: 'Berghaus Lärche',
    pages: [
      {
        path: '/',
        title: 'Home · Berghaus Lärche',
        body: `
          <h1>Berghaus Lärche</h1>
          <p>Berghaus Lärche is an 18-room alpine hideaway on the edge of Seefeld, with direct access to the cross-country trails and the Rosshütte ski area five minutes away by free ski bus.</p>
          <p>Families are welcome: our family rooms have bunk beds and we lend baby cots and high chairs free of charge.</p>
          <p>Dogs welcome for €15 per dog per night, with a dog bed and water bowl in the room.</p>`,
      },
      {
        path: '/rooms/',
        title: 'Rooms · Berghaus Lärche',
        body: `
          <h1>Rooms</h1>
          <h2>Alpine Double</h2>
          <p>The Alpine Double is a 24 m² larch-wood room with mountain views from its own balcony.</p>
          <h2>Family Room</h2>
          <p>The Family Room is 38 m² with a double bed, bunk beds for two children and a balcony.</p>
          <h2>Larch Loft</h2>
          <p>The Larch Loft is 45 m² under the roof, with a private infrared sauna and a panoramic window.</p>
          <p>All rooms have underfloor heating, a kettle with regional teas and a work desk.</p>`,
      },
      {
        path: '/spa/',
        title: 'Spa · Berghaus Lärche',
        body: `
          <h1>Larch-wood spa</h1>
          <p>Our spa has a Finnish sauna, a steam room and an outdoor hot tub facing the Karwendel mountains.</p>
          <p>Book a massage with our therapists, or join the yoga class on Tuesday and Friday mornings.</p>`,
      },
      {
        path: '/dining/',
        title: 'Dining · Berghaus Lärche',
        body: `
          <h1>Dining</h1>
          <p>Our restaurant serves a four-course dinner with half board, based on regional produce from Tyrolean farms.</p>
          <p>The breakfast buffet includes vegan and gluten-free options, and there is a children's menu at dinner.</p>
          <p>After a day on the trails, the bar by the fireplace pours local schnapps.</p>`,
      },
      {
        path: '/faq/',
        title: 'FAQ · Berghaus Lärche',
        body: `
          <h1>Good to know</h1>
          <dl>
            <dt>Parking</dt><dd>Free parking is available behind the house, with two EV chargers.</dd>
            <dt>Skiing</dt><dd>We have a heated ski room with boot dryers.</dd>
            <dt>Check-in</dt><dd>Check-in from 15:00, check-out until 10:30.</dd>
            <dt>Smoking</dt><dd>The whole house is non-smoking.</dd>
          </dl>`,
      },
    ],
  },
  {
    code: 'chs',
    name: 'The Marlowe Charleston',
    pages: [
      {
        path: '/',
        title: 'Home · The Marlowe Charleston',
        body: `
          <h1>The Marlowe</h1>
          <p>The Marlowe is a 32-room boutique inn in a restored 1840s cotton exchange in Charleston's French Quarter, steps from the waterfront and within walking distance of King Street.</p>
          <p>Gather in the courtyard garden under the live oaks, or watch the sunset over the harbor from our rooftop bar.</p>`,
      },
      {
        path: '/rooms/',
        title: 'Rooms · The Marlowe Charleston',
        body: `
          <h1>Rooms &amp; suites</h1>
          <p>The King Room has a king bed, heart-pine floors and a walk-in shower.</p>
          <p>The Double Queen sleeps four and is ideal for families.</p>
          <p>The Piazza Suite has a private porch over the courtyard garden and a soaking tub.</p>
          <p>Every room is air-conditioned and comes with a Nespresso machine, Aesop toiletries and a Smart TV with Netflix.</p>`,
      },
      {
        path: '/amenities/',
        title: 'Amenities · The Marlowe Charleston',
        body: `
          <h1>Amenities</h1>
          <ul>
            <li>Valet parking for $45 per night.</li>
            <li>Complimentary Wi-Fi and a 24/7 reception.</li>
            <li>Fitness center with Peloton bikes.</li>
            <li>Complimentary bicycles to explore the peninsula.</li>
            <li>Pet-friendly: dogs up to 50 lbs stay for a $75 pet fee per stay.</li>
          </ul>
          <h2>Accessibility</h2>
          <p>The inn is wheelchair accessible with step-free access from Queen Street and an elevator to all floors.</p>
          <p>Two ADA rooms have a roll-in shower and grab bars.</p>`,
      },
      {
        path: '/policies/',
        title: 'Policies · The Marlowe Charleston',
        body: `
          <h1>Policies</h1>
          <p>Check-in is at 4 pm and check-out at 11 am.</p>
          <p>A destination fee of $30 per night includes bicycles, a welcome drink and late check-out when available.</p>
          <p>The Marlowe is a non-smoking property.</p>`,
      },
    ],
  },
];

export function renderSitePage(site: FakeSite, page: FakeSitePage): string {
  const jsonLd =
    page.path === '/' && site.jsonLd
      ? `<script type="application/ld+json">${JSON.stringify(site.jsonLd)}</script>`
      : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${page.title}</title>
<meta name="description" content="${site.name} — demo hotel website for local development.">
${jsonLd}
<style>body{font-family:system-ui;max-width:42rem;margin:2rem auto;padding:0 1rem;line-height:1.5}</style>
</head>
<body>
${nav(site.code, site.pages)}
<main>${page.body}</main>
<footer><p>${site.name} · demo website served by the fake Apaleo server</p></footer>
</body>
</html>`;
}

export const FAKE_SITES_ROBOTS = `User-agent: *
Disallow: /sites/*/admin/
Disallow: /connect/
Disallow: /booking/
`;
