/**
 * Simulates an AI agent booking a hotel through the MCP server (or the REST API with --rest):
 * search → offers → hold → status. Prints each step and the checkout link a traveller would get.
 *
 *   pnpm agent-sim
 *   pnpm agent-sim --destination "Charleston" --must "pets allowed" --must "rooftop bar" --nights 3
 *   pnpm agent-sim --rest --api-key lodg_live_...
 */
import { parseArgs } from 'node:util';
import { addDays } from '@lodgent/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { values } = parseArgs({
  // `pnpm agent-sim -- --flag` forwards the separator; drop it.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    url: { type: 'string', default: process.env.API_BASE_URL ?? 'http://localhost:4000' },
    destination: { type: 'string', default: 'Seefeld' },
    must: { type: 'string', multiple: true, default: ['sauna'] },
    nice: { type: 'string', multiple: true, default: [] },
    preferences: { type: 'string', default: 'quiet place to unwind after a day outdoors' },
    'days-ahead': { type: 'string', default: '30' },
    nights: { type: 'string', default: '2' },
    adults: { type: 'string', default: '2' },
    'api-key': { type: 'string' },
    rest: { type: 'boolean', default: false },
    'no-hold': { type: 'boolean', default: false },
  },
});

const checkIn = addDays(new Date().toISOString().slice(0, 10), Number(values['days-ahead']));
const checkOut = addDays(checkIn, Number(values.nights));
const headers: Record<string, string> = { 'x-agent-name': 'agent-sim' };
if (values['api-key']) headers.authorization = `Bearer ${values['api-key']}`;

// biome-ignore lint/suspicious/noExplicitAny: the simulator prints arbitrary payloads.
type Json = Record<string, any>;

const step = (title: string) => console.info(`\n\x1b[1m▶ ${title}\x1b[0m`);

interface Agent {
  call(tool: string, args: Json): Promise<Json>;
  close(): Promise<void>;
}

async function mcpAgent(): Promise<Agent> {
  const client = new Client(
    { name: 'agent-sim', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${values.url}/mcp`), { requestInit: { headers } }),
  );
  const { tools } = await client.listTools();
  console.info(`Connected over MCP. Tools: ${tools.map((t) => t.name).join(', ')}`);
  return {
    async call(tool, args) {
      const result = await client.callTool({ name: tool, arguments: args });
      const text =
        (result.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '';
      if (result.isError) throw new Error(text);
      console.info(text.split('\n\n{')[0]);
      return result.structuredContent as Json;
    },
    close: () => client.close(),
  };
}

function restAgent(): Agent {
  const request = async (method: string, path: string, body?: Json) => {
    const res = await fetch(`${values.url}${path}`, {
      method,
      headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as Json;
    if (!res.ok) throw new Error(`${res.status} ${json.error?.code}: ${json.error?.message}`);
    return json;
  };
  console.info('Using the REST API.');
  return {
    async call(tool, args) {
      switch (tool) {
        case 'search_hotels':
          return request('POST', '/v1/agent/search', args);
        case 'get_offers': {
          const q = new URLSearchParams({
            checkIn: args.checkIn,
            checkOut: args.checkOut,
            adults: String(args.adults),
          });
          return request('GET', `/v1/agent/hotels/${args.hotelId}/offers?${q}`);
        }
        case 'create_hold':
          return request('POST', '/v1/agent/holds', args);
        case 'get_hold_status':
          return request('GET', `/v1/agent/holds/${args.holdId}`);
        default:
          throw new Error(`Unknown tool ${tool}`);
      }
    },
    close: async () => {},
  };
}

const agent = values.rest ? restAgent() : await mcpAgent();
try {
  step(`search_hotels: ${values.destination}, ${checkIn} → ${checkOut}, must have ${values.must.join(', ')}`);
  const search = await agent.call('search_hotels', {
    destination: values.destination,
    checkIn,
    checkOut,
    adults: Number(values.adults),
    mustHave: values.must,
    niceToHave: values.nice,
    preferences: values.preferences,
  });
  if (values.rest) for (const r of search.results) console.info(`${r.rank}. ${r.name}: ${r.why.join('; ')}`);
  const top = search.results[0];
  if (!top) {
    console.info('No hotel matched. Is the demo seeded and published? (pnpm db:seed)');
    process.exitCode = 1;
  } else {
    step(`get_offers: ${top.name}`);
    const offers = await agent.call('get_offers', {
      hotelId: top.hotelId,
      checkIn,
      checkOut,
      adults: Number(values.adults),
    });
    if (values.rest) {
      for (const o of offers.offers)
        console.info(`- ${o.roomType.name} · ${o.ratePlan.name}: ${o.total.formatted}`);
    }
    const cheapest = [...offers.offers].sort((a: Json, b: Json) => a.total.amount - b.total.amount)[0];
    if (cheapest && !values['no-hold']) {
      step(
        `create_hold: ${cheapest.roomType.name} · ${cheapest.ratePlan.name} for ${cheapest.total.formatted}`,
      );
      const hold = await agent.call('create_hold', { offerId: cheapest.offerId });
      if (values.rest) console.info(`Checkout link: ${hold.checkoutUrl}`);

      step('get_hold_status');
      const status = await agent.call('get_hold_status', { holdId: hold.holdId });
      if (values.rest) console.info(`${status.status}: ${status.nextStep}`);
      console.info(`\nOpen the checkout link to finish as the guest:\n${hold.checkoutUrl}`);
    }
  }
} finally {
  await agent.close();
}
