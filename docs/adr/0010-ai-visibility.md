# 0010. AI visibility monitor: web-search answers, deterministic parsing, per-org cost cap

Date: 2026-10-11 · Status: accepted

## Context
Hotels want to know whether AI assistants recommend them when travellers ask where to stay, who gets recommended instead, and which sources the assistants cite. The spec asks for:
- auto-suggested target queries per property, editable;
- scheduled runs across Anthropic, OpenAI, Gemini and Perplexity, each with web search;
- parsing of mention, rank, competitors and cited sources;
- a dashboard with share of voice, a per-provider breakdown, competitors, missing queries and recommendations;
- a per-org monthly cost cap.

Docs check (October 2026). Where provider docs were not reachable from the build environment, findings come from the official SDKs' type definitions:
- **Anthropic** (`@anthropic-ai/sdk`): the server tool `web_search_20260209` (dynamic filtering) is available on current Claude models.
  - Options include `max_uses` and `user_location`. Citations arrive as `web_search_result_location` blocks on text.
  - `usage.server_tool_use.web_search_requests` counts searches, billed at $10 per 1,000 on top of tokens.
  - A long server-tool turn can stop with `pause_turn`; we resume it by sending the assistant turn back.
- **OpenAI** (`openai`): the Responses API with the `web_search` tool (`user_location` approximate). Citations come as `url_citation` annotations on `output_text`, and `web_search_call` output items count searches. The SDK reports tokens but no prices.
- **Gemini** (`@google/genai` 2.28.0): `tools: [{ googleSearch: {} }]` grounding.
  - `candidates[0].groundingMetadata` carries `groundingChunks[].web { uri, title }` and `webSearchQueries`.
  - Chunk URIs are Google redirect links; the `title` holds the source domain, which we use as the cited host.
- **Perplexity** (`@perplexity-ai/perplexity_ai` 0.38.8): Sonar models search natively. The response carries `search_results[] { url, title }`, and `usage.cost.total_cost` gives the exact request cost in USD. `web_search_options.user_location` is supported.

Model names and per-token prices for OpenAI, Gemini and Perplexity could not be confirmed from their docs. They are env-configurable defaults, and the price table falls back to the most expensive known price for unknown models (SETUP-NEEDED).

## Decision
- **Adapters behind one port** (`VisibilityProvider` in core: `ask(question, { location }) → { text, citations, model, costCents, searches }` plus `estimateCostCents()`), in `packages/llm`.
  - Every adapter uses the same light system prompt asking for a short named list, so answers are comparable.
  - Each adapter sets the hotel's city/country as the user location, as a local traveller's assistant would.
  - Anthropic caps searches at `max_uses: 3` and resumes `pause_turn` at most twice.
- **Providers are enabled by key.** Each provider with an API key is used. Without any key, local development and tests use deterministic **simulated assistants** that recommend from the published hotels in the same city (and sometimes cite their sites), at zero cost. Production never falls back to simulated providers, and the dashboard labels simulated answers as such.
- **Parsing is deterministic code, not a second LLM call** (`analyzeAnswer` in core), so it is cheap, repeatable and unit-tested:
  - **Mention:** accent- and case-folded name variants (full name; name without generic words like "Hotel"/"The"; without the city), matched on word boundaries. Variants shorter than 6 characters, or single words under 7, are dropped to avoid false positives.
  - **Rank:** the 1-based position of the hotel among list items (numbered, bulleted or heading lines). The item's leading name is taken from bold or link text, or the text before a dash or colon.
  - **Competitors:** the other listed names.
  - **Sources:** cited URLs, plus flags for the hotel's own domain and our public profile domain.
- **Queries:** `suggestQueries` seeds up to 10 questions per property from the city and the hotel's most important approved attributes ("dog-friendly hotels in Lisboa", "where to stay in Lisboa", …) when visibility is first opened. Hotels add their own and remove any, with up to 20 active.
- **Scheduling:**
  - A weekly `visibility.schedule-all` job creates a run per published property for orgs with monitoring enabled.
  - Hotels can also run a check manually, at most once an hour per property and never while a run is in flight.
  - Runs execute in the worker (`visibility.run`) with concurrency 4 across question × provider pairs. Individual failures are recorded per result and do not fail the run.
- **Cost cap:** each org has a monthly cap (default `VISIBILITY_DEFAULT_MONTHLY_CAP_CENTS`, editable in the dashboard).
  - Before every call, the run reserves the provider's estimate against this month's spend. If the call would exceed the cap, the run stops as `capped` with what it has.
  - After the call, the reservation is corrected to the reported cost. Spend is the sum of recorded result costs, so it is exact and auditable.
- **Privacy and retention:** visibility questions are about hotels, never guests, so no guest data is involved.
  - Full answer texts are kept for `VISIBILITY_RAW_RETENTION_DAYS`, then a daily job purges them.
  - The parsed fields (mention, rank, competitors, citations, excerpt) are kept for trends.

## Consequences
- Results are a sample, not a ranking: answers vary run to run and by location. The dashboard shows rates over the latest run and a trend across runs, never a single answer as truth.
- Cost per weekly run is roughly questions × providers × a few cents. With 10 questions and 4 providers that is about $1–3 per property per week, well under the default cap.
- The parser can miss mentions phrased very differently from the hotel's name (nicknames, translations). The dashboard shows the excerpt around each mention so hotels can judge; the full answer stays in the database until the retention purge.
- Adding a provider means one adapter class and a key; nothing else changes.
