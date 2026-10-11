# Connecting AI agents

Lodgent exposes the same five capabilities over MCP and REST:

| MCP tool | REST | What it does |
| --- | --- | --- |
| `search_hotels` | `POST /v1/agent/search` | Ranked hotels for a destination, dates, party and requirements, each with reasons |
| `get_hotel` | `GET /v1/agent/hotels/{hotelId}` | Approved profile: facts, rooms, sellable rates, policies |
| `get_offers` | `GET /v1/agent/hotels/{hotelId}/offers` | Live all-in offers from the hotel's PMS |
| `create_hold` | `POST /v1/agent/holds` | Holds an offer for ~15 minutes and returns the guest's checkout URL |
| `get_hold_status` | `GET /v1/agent/holds/{holdId}` | Active, processing, confirmed (with confirmation number), failed, expired |

- MCP endpoint: `<API_BASE_URL>/mcp` (Streamable HTTP, stateless; serves both the 2026-07-28 protocol and 2025-era clients).
- OpenAPI 3.1 for the agent API: `<API_BASE_URL>/openapi.json`.
- Locally `API_BASE_URL` is `http://localhost:4000`.

**Payment data never goes through agents.** Holds return a checkout URL; the guest enters their own details and pays on the hosted page. Don't send guest names or contact details in tool calls either.

## Try it locally

```sh
docker compose up -d && pnpm dev   # API on :4000, dashboard on :3000, fake Apaleo on :4010
pnpm agent-sim                      # search → offers → hold over MCP, prints the checkout link
pnpm agent-sim --destination Charleston --must "pets allowed" --nice "rooftop bar" --nights 3
pnpm agent-sim --rest               # the same flow over REST
```

Hotels must be published to appear (the demo seed publishes three).

## MCP Inspector

```sh
npx @modelcontextprotocol/inspector
```

In the Inspector UI choose the **Streamable HTTP** transport and enter `http://localhost:4000/mcp`. Add the header `X-Api-Key: <partner key>` if you have one. **Tools → List tools** shows the five tools with their schemas; `search_hotels` with `{ "destination": "Seefeld", "mustHave": ["sauna"] }` is a good first call.

## Claude Code

```sh
claude mcp add --transport http lodgent http://localhost:4000/mcp
# with a partner key:
claude mcp add --transport http lodgent http://localhost:4000/mcp --header "X-Api-Key: lodg_live_..."
```

Then ask, for example: *"Find a hotel in Seefeld with a sauna for 2 adults next month and hold the cheapest room."*

## Claude Desktop

A deployed (public HTTPS) Lodgent: **Settings → Connectors → Add custom connector**, URL `https://<api host>/mcp`.

Against a local server, Claude Desktop launches MCP servers as local processes, so bridge to HTTP with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote). In `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "lodgent": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:4000/mcp", "--header", "X-Api-Key:${LODGENT_API_KEY}"],
      "env": { "LODGENT_API_KEY": "lodg_live_..." }
    }
  }
}
```

Omit the header arguments for anonymous access. Restart Claude Desktop; the tools appear under the connector menu.

## REST examples

```sh
curl -s localhost:4000/v1/agent/search -H 'content-type: application/json' -d '{
  "destination": "Lisbon", "checkIn": "2026-12-04", "checkOut": "2026-12-06",
  "adults": 2, "mustHave": ["free wifi"], "niceToHave": ["river view"],
  "preferences": "historic house, walkable neighbourhood"
}' | jq '.results[] | {name, why, offer: .cheapestOffer.total.formatted}'

curl -s "localhost:4000/v1/agent/hotels/<hotelId>/offers?checkIn=2026-12-04&checkOut=2026-12-06&adults=2"
curl -s localhost:4000/v1/agent/holds -H 'content-type: application/json' -d '{"offerId":"<offerId>"}'
curl -s localhost:4000/v1/agent/holds/<holdId>
```

## Requirements and ranking

- `mustHave` and `niceToHave` take plain phrases ("sauna", "dog friendly", "free parking", "bathtub"). Each is mapped to the attribute vocabulary (`interpreted` in the response shows how). A phrase we can't map is used as a soft preference instead (`treatedAsPreferences`).
- Must-haves are hard filters on values the hotel approved. A room-level requirement (e.g. bathtub) needs a room type that has it and fits the party.
- The score mixes semantic similarity to `preferences` (40%), the share of nice-to-haves met (25%), price fit against `budgetPerNight` or the cheapest result (25%), and profile completeness (10%). Components that don't apply (no preferences, no dates) drop out and the weights renormalize. Ties break on price, then name. The same request always gives the same order.
- With dates, the top 12 candidates are priced live; hotels without availability are left out.

## Partner keys and limits

Anonymous callers get `ANONYMOUS_RATE_LIMIT_PER_MINUTE` (default 30) requests per minute per IP. Partners send `X-Api-Key: <key>` (or `Authorization: Bearer <key>`) and get `PARTNER_RATE_LIMIT_PER_MINUTE` (default 300) per key, plus attribution of searches, holds and bookings. An invalid key is rejected (401) rather than treated as anonymous.

```sh
pnpm --filter @lodgent/scripts partner-key create "Trip Planner AI" partners@tripplanner.example
pnpm --filter @lodgent/scripts partner-key list
pnpm --filter @lodgent/scripts partner-key revoke <id>
```

## What is logged

Each request records the tool, coarse destination, dates, party size, the interpreted attribute codes, whether free-text preferences were given (not the text), result count, latency, partner and UTM tags. Each hotel sees its own impressions, views, offer views and holds. No guest data and no free text from agents is stored.
