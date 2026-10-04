# Exa reference for event search

Compiled 2026-10-04. Sources: `refs/docs/exa-llms-full.txt` (pulled from the current exa.ai docs), the OpenAPI spec (`https://exa.ai/docs/exa-spec.yaml`, read via the `https://exa.ai/docs/reference/*.md` pages), and the installed SDK at
`node_modules/exa-js` **v2.25.0** (`dist/index.d.ts`, `dist/index.js`). `refs/repos/exa-labs_exa-js` is the same version.
**Where the docs and the SDK disagree, the installed SDK decides the TS option names.** Mismatches are marked **[MISMATCH]**.

Note on paths: "llms-full §X" below means the section in `refs/docs/exa-llms-full.txt` whose `Source:` line is `https://exa.ai/docs/X`.

---

## 0. TL;DR for this project

- Use `exa.search(query, { type: "auto"|"fast", numResults, contents: { highlights: true } })` for chat. Put the **city and date window in the query text**. No Exa filter matches event dates.
- `startPublishedDate`/`endPublishedDate` filter on the **page publish date, not the event date**. Do not use them for "next 14 days".
- To get structured events from search results, use `outputSchema` (+ `systemPrompt`). It works with every `type`. The cap is **10 properties total and 2 nesting levels**, and it adds about 2 s. Each field gets citations in `output.grounding[]` (`field`, `citations[{url,title}]`, `confidence`).
- For venue calendar pages with many showtimes, extract per page instead: `getContents(urls, { summary: { schema }, maxAgeHours })` or `text` plus your own LLM. Synthesis across many results tends to drop items.
- Exa Agent (`exa.agent.runs.*`) is async, takes seconds to minutes, costs $0.012 to $1 per fixed-effort run, and has no 10-property limit. It fits a nightly batch, not chat.
- Monitors (`exa.monitors.*`) are in the SDK. They are scheduled searches (min 1h) with a webhook, signed with HMAC-SHA256 in `Exa-Signature`. Each run filters to content published since the last run and semantically dedupes, so they suit "new announcements" and do **not** suit re-reading evergreen venue calendars.
- The SDK has **no retries**. Handle 429/5xx yourself.

---

## 1. Search API: `POST /search`, `exa.search()`

Sources: llms-full §search/quickstart, §search/best-practices, §search/highlights, §reference/search (OpenAPI), `node_modules/exa-js/dist/index.d.ts` (`BaseSearchOptions`, `RegularSearchOptions`, `ContentsOptions`, `SearchResponse`).

### 1.1 SDK signatures (installed 2.25.0)

```ts
import Exa, { DYNAMIC_HIGHLIGHTS_BETA, ExaError } from "exa-js";
const exa = new Exa(process.env.EXA_API_KEY); // falls back to env EXA_API_KEY; baseURL default https://api.exa.ai

// overloads
exa.search(query: string): Promise<SearchResponse<{ text: { maxCharacters: 10_000 } }>>;
exa.search(query, opts: RegularSearchOptions & BetaOptions & { contents: false | null | undefined }): Promise<SearchResponse<{}>>;
exa.search<T extends ContentsOptions>(query, opts: RegularSearchOptions & BetaOptions & { contents: T }, requestOptions?: { body?: Record<string, unknown> }): Promise<SearchResponse<T>>;
exa.search(query, opts /* no contents key */): Promise<SearchResponse<{ text: true }>>;
exa.streamSearch(query, opts): AsyncGenerator<SearchStreamChunk>; // use this, not search({stream:true}) (throws)
```

**SDK gotcha:** if you pass options **without a `contents` key**, the SDK injects `contents: { text: { maxCharacters: 10000 } }` (`buildSearchRequestBody` in `dist/index.js`). Always set `contents` explicitly: `{ highlights: true }`, or `false` when you only want URLs and `output`. The d.ts overload claims `{ text: true }`, but the code sends `maxCharacters: 10000`. **[MISMATCH, minor]**

`requestOptions.body` (new in 2.25.0) merges raw fields into the request body. Use it as an escape hatch for API fields the TS types lack.

### 1.2 Options (`BaseSearchOptions` + `BaseRegularSearchOptions`)

| Option | TS type (SDK) | API limits / notes |
|---|---|---|
| `query` | `string` (positional) | required, minLength 1 |
| `type` | `"keyword"\|"neural"\|"auto"\|"hybrid"\|"fast"\|"instant"` or `DeepSearchType = "deep-lite"\|"deep"\|"deep-reasoning"` | API enum is only `instant, fast, auto, deep-lite, deep, deep-reasoning` (default `auto`). **[MISMATCH]** The SDK still allows the legacy `keyword/neural/hybrid`. Don't use them. |
| `numResults` | `number` | 1–100, default 10. No pagination. More than 10 are billed extra. `INVALID_NUM_RESULTS` if >100 with highlights. |
| `includeDomains` / `excludeDomains` | `string[]` | up to 1200 entries. Accepts `example.com`, path prefixes `example.com/events`, wildcards `*.example.com`. Use instead of `site:`. |
| `startPublishedDate` / `endPublishedDate` | `string` (ISO 8601) | **Filters the page's publish date, not the event date.** Not supported with `category: company/people` (400). |
| `category` | `"company"\|"publication"\|"news"\|"personal site"\|"financial report"\|"people"` | No events category. The API says "other strings are accepted and used as category hints", but the SDK type is a closed union **[MISMATCH]**, so you'd need a cast. `pdf`, `github`, `tweet` are deprecated. |
| `userLocation` | `string` | ISO 3166-1 alpha-2 **country** code (e.g. `"DE"`). Biases results to the region. No city-level control, so put the city in the query. |
| `objective` | `string` | ≤4096 chars. The broader goal of the search ("which docs should rank first, which to exclude, what facts to pull"). Recommended when an LLM writes the query. |
| `systemPrompt` | `string` | Guides search behaviour and synthesis (source preferences, dedupe, novelty). |
| `outputSchema` | `DeepOutputSchema` | See §2. |
| `additionalQueries` | `string[]` (deep types only, enforced by a TS discriminated union) | API: 1–**10** items. The SDK JSDoc says "Max 5". **[MISMATCH]** Trust the API (10). |
| `moderation` | `boolean` | default false |
| `contents` | `ContentsOptions \| false` | See §1.4. |
| `betas` | `string[]` | Sends the `Exa-Beta` header, e.g. `[DYNAMIC_HIGHLIGHTS_BETA]` = `"dynamic-highlights-2026-08-28"`. |
| `stream` | `boolean` | Only meaningful with `outputSchema`. Use `streamSearch()`. |
| `includeText`/`excludeText`, `startCrawlDate`/`endCrawlDate`, `useAutoprompt`, `flags` | n/a | Deprecated or ignored. Don't use. |

### 1.3 Search types and latency (search/quickstart, admin/pricing)

| `type` | Typical latency | Price (≤10 results) | Notes |
|---|---|---|---|
| `instant` | ~250 ms (changelog: sub-150 ms) | $4 / 1k | real-time/autocomplete/voice |
| `fast` | ~450 ms | $7 / 1k | latency-sensitive UI |
| `auto` (default) | ~1 s | $7 / 1k | best default |
| `deep-lite` | ~4 s | $12 / 1k | lightweight expansion + synthesis |
| `deep` | 4–15 s | $12 / 1k | iterative search, good for multi-item structured output |
| `deep-reasoning` | 12–40 s | $15 / 1k | Exa suggests the Agent instead |

These latencies assume cached content and no `outputSchema`. `outputSchema` adds about 2 s of synthesis. A low `contents.maxAgeHours` adds a live fetch (up to `livecrawlTimeout`, default 10 s).

### 1.4 Contents options (`ContentsOptions`, nested under `contents` on /search)

```ts
type ContentsOptions = {
  text?: true | { maxCharacters?: number /*1..1e6*/; includeHtmlTags?: boolean;
                  verbosity?: "compact"|"standard"|"full";            // needs maxAgeHours: 0
                  includeSections?: SectionTag[]; excludeSections?: SectionTag[] }; // needs maxAgeHours: 0
  highlights?: true | { query?: string; maxCharacters?: number; dynamic?: boolean /* beta, not with maxCharacters */ };
  summary?: true | { query?: string; schema?: Record<string, unknown> | ZodSchema };  // 1 LLM call per page
  maxAgeHours?: number;        // -1..720
  livecrawlTimeout?: number;   // ms, default 10000, max 90000
  livecrawl?: "never"|"fallback"|"always"|"auto"|"preferred"; // DEPRECATED; never send with maxAgeHours
  snapshotAsOf?: string;       // historical stored version
  filterEmptyResults?: boolean;// default true
  subpages?: number;           // 0..100
  subpageTarget?: string | string[];
  extras?: { links?: number; imageLinks?: number };
};
// SectionTag = "unspecified"|"header"|"navigation"|"banner"|"body"|"sidebar"|"footer"|"metadata"
```

- **highlights** are recommended: query-relevant extractive passages, sized automatically. Use `highlights: true` and only set `maxCharacters` if you need a hard cap. Exa's numbers: 500 chars of highlights match the first 8k chars of text, with 16x fewer tokens. `highlights.query` re-targets the extraction, e.g. `"dates, times, venue, ticket price"`.
- **text** returns the clean markdown body. Use it when you need the whole page, e.g. a calendar with 40 showtimes. Bound it with `maxCharacters`.
- **summary** makes one LLM call per result, $1/1k pages. With `schema`, it returns a **JSON string**, so you must `JSON.parse(result.summary)`. This is useful for per-page extraction (§4.2).
- Docs advise one view per request. "Requesting both highlights and text returns and bills two views." **[DOC INCONSISTENCY]** The pricing page and changelog say contents for the first 10 search results are included in the $7 base price.
- Freshness: `maxAgeHours` controls **cached page age, not publish date**. Omit it to use cache and fetch if missing. `N` uses cache if younger than N hours, otherwise fetches live. `0` always fetches live. `-1` is cache only. Legacy mapping: `livecrawl:"always"`→`0`, `"never"`→`-1`, `"fallback"`→omit, `"preferred"`→a low value like `1`.

### 1.5 Response (`SearchResponse<T>`)

```ts
type SearchResponse<T> = {
  results: Array<{ id: string; url: string; title: string | null; publishedDate?: string; author?: string;
                   image?: string; favicon?: string; score?: number /* not returned for auto */;
                   entities?: Entity[] /* company/people only */ } & ContentsResultComponent<T>>; // highlights: string[], text: string, summary: string, subpages, extras
  output?: { content: string | Record<string, unknown>; grounding: DeepSearchOutputGrounding[] }; // only with outputSchema
  requestId: string; searchTime?: number /* ms, may exclude synthesis */; costDollars?: { total: number; search?: {...}; contents?: {...} };
  statuses?: Status[]; resolvedSearchType?: string /* deprecated, may be "" */;
};
```

`publishedDate` is the page's estimated creation date. It is often missing or unrelated to the event date on event pages.

### 1.6 Example: on-demand chat search

```ts
const res = await exa.search(
  "Upcoming jazz concerts in Berlin between 5 and 19 October 2026, venue event pages with date and ticket info",
  {
    type: "fast",
    numResults: 10,
    userLocation: "DE",
    objective: "Find individual upcoming event listings (not news or reviews) in Berlin in the next 14 days; prefer venue or ticketing pages; pull date, time, venue, price.",
    excludeDomains: ["wikipedia.org"],
    contents: { highlights: { query: "event date, start time, venue, ticket price" } },
  },
);
for (const r of res.results) console.log(r.url, r.title, r.highlights);
```

---

## 2. `outputSchema` + `systemPrompt` (synthesized/structured output)

Sources: llms-full §search/quickstart#output-schema, §search/deep-search#output-schema-limits and #read-the-grounded-response, §reference/search (`OutputSchemaObject`, `SearchSynthesisOutputOutput`), SDK `DeepOutputSchema`, `DeepSearchOutput`.

### 2.1 Shape and limits

```ts
type DeepOutputSchema =
  | { type: "text"; description?: string }                                         // prose -> output.content: string
  | { type: "object"; properties?: Record<string, unknown>; required?: string[] }; // JSON -> output.content: object
```
- It **works with every search type, including `auto`, `fast` and `instant`.** Exa recommends deep types when the output needs 3+ fields that one retrieval pass can't fill, or more than 2 structured items.
- Limits are validated before the search. A violation returns `400` (e.g. `output_schema exceeds maximum of 10 properties`, tag `INVALID_JSON_SCHEMA`):
  - **At most 10 properties in total**, counting every level (array `items` properties count too).
  - **At most 2 levels of nested objects** below the root. `events → items → title` is OK. An object inside the item is not.
  - Every `type: "array"` must define `items`.
  - `maxItems` is allowed (docs use 8–10). No documented upper bound.
- The API also accepts root `description` and `additionalProperties` on object schemas. The **SDK type `DeepObjectOutputSchema` does not declare them** **[MISMATCH]**, so object literals with them fail excess-property checks. Cast or use `requestOptions.body`.
- The SDK passes `outputSchema` through as-is in `search()` and does **not** convert Zod there. Zod conversion only exists for `answer()`, `agent.runs.create`, and `summary.schema`. Use `z.toJSONSchema()` (zod v4 is in package.json) and strip unsupported keywords if needed.
- **Do not add citation or confidence fields.** Exa returns them in `output.grounding`.
- `systemPrompt` describes how to research and present (source preferences, "exclude past events", "one item per performance", date format). `outputSchema` describes the shape. The query describes what to find.

### 2.2 Response: `output.content` + `output.grounding` (exact)

```ts
type DeepSearchOutput = {
  content: string | Record<string, unknown>;   // matches your schema when type:"object"
  grounding: Array<{
    field: string;                              // path into output.content, e.g. "content" (text mode) or "events[3].start"
    citations: Array<{ url: string; title: string }>;  // both required in the API spec
    confidence: "low" | "medium" | "high";      // model-reported reliability for this field
  }>;
};
```
- `results[]` still contains the ranked pages. `numResults` sets how many pages come back, not how many searches Deep runs.
- The API spec marks only `output.content` as required. The SDK types `grounding` as non-optional, so guard with `output.grounding ?? []`. **[MISMATCH, minor]**
- Grounding is **per field**, so one event has up to N entries (`events[0].title`, `events[0].start`, …). To get "the source URL of event i", collect citations where `field.startsWith("events[i]")`. Still ask for a `url` field in the schema (the event or ticket page), because a citation can point to an aggregator.
- With `stream: true` + `outputSchema` (via `streamSearch` or raw fetch), SSE chunk types are `text-delta`, `grounding`, `results`, `stream-reset`, `done` (final output + cost), and `error`. The stream ends with `data: [DONE]`.

### 2.3 Cost and latency

- There is **no separate line item** for `outputSchema` on the pricing page. You pay the search type's base price ($7/1k for auto/fast, $12/1k for deep). Verify with `costDollars.total`. *(Inference from admin/pricing. Not stated explicitly.)*
- Latency is about +2 s on top of the search type (API spec text). So expect `auto` ≈ 3 s and `deep` ≈ 6–17 s.

### 2.4 Example: structured events from a search

```ts
const eventsSchema = {
  type: "object",
  properties: {
    events: {
      type: "array",
      maxItems: 15,
      items: {
        type: "object",
        properties: {
          title:  { type: "string" },
          start:  { type: "string", description: "Local start date-time ISO 8601 incl. year, e.g. 2026-10-09T20:00" },
          venue:  { type: "string" },
          url:    { type: "string", description: "Event or ticket page URL" },
          price:  { type: "string", description: "Price text as shown, e.g. 'from €18', 'free', or 'unknown'" },
          kind:   { type: "string", enum: ["concert", "film", "talk", "meetup", "other"] },
          blurb:  { type: "string", description: "One sentence on what it is" },
        },
        required: ["title", "start", "venue", "url"],
      },
    },
  },
  required: ["events"],
} as const; // 1 + 7 = 8 of 10 properties

const res = await exa.search("Indie and jazz concerts in Berlin, 5–19 October 2026", {
  type: "deep",                     // or "auto" when you need it faster and fewer items
  numResults: 15,
  userLocation: "DE",
  systemPrompt:
    "Only events physically in Berlin with a start date between 2026-10-05 and 2026-10-19. " +
    "One item per performance/showtime. Skip past, cancelled or undated events. Prefer venue and ticketing pages over listicles. " +
    "Never invent prices; use 'unknown' if not shown.",
  outputSchema: eventsSchema as any, // cast only if you add root description/additionalProperties
  contents: { highlights: true },
});
const events = (res.output?.content as any)?.events ?? [];
const g = res.output?.grounding ?? [];
const sourcesFor = (i: number) =>
  [...new Set(g.filter(x => x.field.startsWith(`events[${i}]`)).flatMap(x => x.citations.map(c => c.url)))];
```

### 2.5 Fitness for event extraction and gotchas

- **Single event pages:** a good fit. With highlights, the synthesis sees date, venue and price passages. Grounding gives you per-field provenance.
- **Venue calendar pages (many showtimes on one URL):** a weak fit for search-level synthesis. Synthesis works over highlights or retrieved content across *all* results, so long calendars get truncated, items get dropped, and `maxItems` caps the total across all sources. For calendars, extract **per page** (§4.2) and treat search `outputSchema` as discovery.
- The 10-property cap forces a lean schema. Keep the event row at 6–8 fields and enrich later. It also rules out nested `venue{name,address}` plus `price{min,max,currency}`. Use flat strings.
- Synthesis can produce dates without a year or timezone, or carry over "every Friday" patterns. Require ISO-with-year in the description, then **re-validate dates in code** and drop anything outside the window.
- `confidence` is model-reported. Treat `low` as "needs page check".
- Without a schema-forced `url`, there is no single canonical URL per item. Grounding citations can include aggregators.
- Search results are cached. A cancelled or sold-out show can still appear. Use `contents.maxAgeHours` (e.g. 24) when correctness matters, which costs latency.

---

## 3. Deep search (`type: "deep-lite" | "deep" | "deep-reasoning"`)

Source: llms-full §search/deep-search, §admin/pricing#deep-search, §admin/billing#rate-limits.

- It uses the same `/search` endpoint. It adds a research loop: plan (expand the query, optionally seeded by `additionalQueries`), search and inspect, refine with targeted searches, then select and synthesize. It is designed for lists and multi-item structured outputs where each item may need its own search.
- Only deep types accept `additionalQueries` (≤10 per API). Each should be a genuinely different direction, not a rephrasing, e.g. `["Berghain October 2026 program", "Kino Babylon Programm Oktober 2026", "Berlin tech meetups October 2026"]`.
- Structured output works the same way (`outputSchema` → `output.content` + `output.grounding`), with the same 10-property and depth-2 limits. If you need more fields, split into several requests or use the Agent.
- `contents` on deep uses `DeepContentsOptions` (same as `ContentsOptions`).
- Cost and latency: `deep-lite` $12/1k at ~4 s, `deep` $12/1k at 4–15 s, `deep-reasoning` $15/1k at 12–40 s. Results above 10 cost $1/1k and summaries $1/1k pages, as on standard search.
- The rate limit is **5 QPS for deep types**, versus 10 QPS for standard /search.
- Skip deep when you only need pages, when your own LLM does the reasoning, or on interactive or voice paths.

---

## 4. Contents API: `POST /contents`, `exa.getContents()`

Sources: llms-full §contents/quickstart, §reference/get-contents (OpenAPI), §admin/error-codes#content-fetch-status-tags, SDK `getContents`.

```ts
exa.getContents<T extends ContentsOptions>(
  urls: string | string[] | SearchResult<T>[],   // accepts search results directly (uses .url)
  options?: T & BetaOptions,
): Promise<SearchResponse<T>>;                   // results[] + statuses[] + costDollars
```
- Body: `urls` (or `ids`), **1–100 per request**, each ≤2048 chars. Content options sit at the **top level**, not under `contents`. The SDK spreads them for you. With no view requested, the API returns text.
- Options are the same as `ContentsOptions` (§1.4): `text`, `highlights` (+`query`), `summary` (+`query`, `schema`), `maxAgeHours` (−1..720), `livecrawlTimeout` (default 10000 ms, max 90000; use 12000–15000 for slow sites), `subpages` (0–100), `subpageTarget` (string or string[], fuzzy match on link text/URL, e.g. `["events","programm","calendar","tickets"]`), `extras.links`/`imageLinks`, `filterEmptyResults`.
- `SUBPAGES_LIMIT_EXCEEDED` (400) means more than 100 subpages per request.
- Per-URL failures don't fail the request. Check `statuses[]`: `{ id, status: "success"|"error", source?: "cached"|..., error?: { tag, httpStatusCode } }`. Tags: `CRAWL_NOT_FOUND`, `CRAWL_HTTP_{status}`, `CRAWL_TIMEOUT`, `CRAWL_LIVECRAWL_TIMEOUT`, `SOURCE_NOT_AVAILABLE`, `UNSUPPORTED_URL`, `CRAWL_UNKNOWN_ERROR`.
- Exa's crawler respects robots.txt and does not bypass logins, paywalls or CAPTCHAs. Ticket shops behind bot walls will return errors. Fall back to the browser tool.
- Cost: **$1 / 1k pages per content type** (text, highlights and summary each count). AI summaries add $1/1k pages. Rate limit is 100 QPS.

### 4.1 Freshness for calendars

```ts
const r = await exa.getContents(venueCalendarUrls, {
  text: { maxCharacters: 40_000 },
  maxAgeHours: 24,          // re-fetch if our cached copy is older than a day
  livecrawlTimeout: 15_000,
});
```

### 4.2 Per-page structured extraction (best fit for calendar pages)

`summary.schema` runs one LLM call **per page**, so attribution is per page by construction. The 10-property cap of `outputSchema` is not documented to apply here, but keep the schema small. Exa documents no limits for it.

```ts
const pageEvents = await exa.getContents(urls, {
  maxAgeHours: 24,
  summary: {
    query: "List every upcoming event/showtime on this page between 2026-10-05 and 2026-10-19",
    schema: {
      type: "object",
      properties: {
        events: { type: "array", items: { type: "object", properties: {
          title: { type: "string" }, start: { type: "string", description: "ISO 8601 local incl. year" },
          price: { type: "string" }, url: { type: "string" } }, required: ["title", "start"] } },
      },
      required: ["events"],
    },
  },
});
for (const r of pageEvents.results) {
  const parsed = JSON.parse((r as any).summary ?? "{}"); // summary is a JSON string
}
```
If a calendar is long or paginated, `text` plus your own LLM extractor (Mastra agent) gives you full control and a deterministic window filter. Summary quality on very long pages is undocumented.

---

## 5. Exa Agent API: `POST /agent/runs`, `exa.agent.runs.*`

Sources: llms-full §agent/quickstart, §agent/best-practices, §agent/agent-ultra, §admin/pricing#agent, §admin/billing#agent-limits, `reference/agent-api/create-a-run.md` (OpenAPI), SDK `AgentRunsClient`.

### 5.1 SDK surface

```ts
exa.agent.runs.create(params: CreateAgentRunParams & { stream?: false }): Promise<AgentRun>;          // returns immediately (queued)
exa.agent.runs.create(params & { stream: true }): Promise<AsyncGenerator<AgentEvent>>;                // SSE
exa.agent.runs.createAndWait(params, opts?: { pollInterval?: number; timeoutMs?: number }): Promise<AgentCompletedRun>; // default timeout 2 min!
exa.agent.runs.pollUntilFinished(runId, opts?): Promise<AgentTerminalRun>;  // default pollInterval 1000 ms, timeout 1 h
exa.agent.runs.get(id) / list({cursor,limit}) / listAll() / getAll() / cancel(id) / stop(id /* ultra only */) / delete(id)
exa.agent.runs.events.list(runId, {cursor,limit})

interface CreateAgentRunParams {
  query: string; systemPrompt?: string;
  input?: { data?: Record<string, unknown>[]; exclusion?: Record<string, unknown>[] };
  outputSchema?: Record<string, unknown> | ZodSchema<T>;   // Zod converted by SDK
  effort?: "minimal"|"low"|"medium"|"high"|"xhigh"|"auto"|"ultra"|"max"; // "max" = SDK-only beta (AGENT_MAX_EFFORT_BETA) [MISMATCH: not in API spec]
  budget?: { maxCostDollars?: number /* $1–$100, auto/ultra only */; maxDurationSeconds?: number /* 300–10800, ultra only */ };
  previousRunId?: string; metadata?: Record<string, unknown> /* API: string values only [MISMATCH] */;
  dataSources?: { provider: string }[];  // Exa Connect partners, not needed for web
}
// AgentRun: { id, status: "queued"|"running"|"completed"|"failed"|"cancelled", stopReason?: "schema_satisfied"|"budget_reached"|"time_limit_reached"|"stopped"|"error"|"cancelled",
//             output?: { text?: string|null; structured?: T; grounding?: { field; citations: {url; title?}[]; score?; confidence?: "low"|"medium"|"high"|null }[] },
//             usage?: { agentComputeUnits, searches, ... }, costDollars?: { total, agentCompute, search, ... }, error?: { code, message, ... } }
```
The beta header is no longer needed for `exa.agent`. `exa.beta.agent` is deprecated.

### 5.2 Model, cost and latency

- It is async: create, persist `id`, then poll, stream, or replay events (`GET /agent/runs/{id}/events`, SSE with `Last-Event-ID`). It fans out many searches, reads pages, splits list-building into parallel subtasks, verifies each candidate, and returns `output.structured` validated against **full JSON Schema**. There is **no 10-property limit**.
- Schema adherence validates shape, not facts. Fields may come back `null` even if marked required. Make uncertain fields nullable. An unsatisfiable schema fails fast with `400 INVALID_OUTPUT_SCHEMA`.
- Effort and price: `minimal` $0.012, `low` $0.025, `medium` $0.10, `high` $0.50, `xhigh` $1.00 per run (fixed). `auto` (default) is metered with a $5 default cap. `ultra` is metered with a $20 cap. Metered rates are $0.10/ACU plus $0.005/search.
- Latency is "seconds to minutes" with no SLA. Ultra typically takes ~30 min and up to 3 h. Docs say to benchmark before putting it on a synchronous UI path.
- Limits: **50 concurrent active runs** (`429 CONCURRENCY_LIMIT_REACHED`). Each create counts as 2 requests against QPS (5 run starts/s at 10 QPS). GET polling does not count.

### 5.3 Viability for "events matching X in city Y, next 2 weeks"

It is viable for a **nightly per-user or per-city batch**, not for chat. Use `effort: "auto"` with `budget.maxCostDollars` (e.g. 1–2), or fixed `medium`/`high` for predictable cost. Bound the list with `maxItems`. Pass already-known events via `input.exclusion` (e.g. `[{ url }]`) so reruns surface new ones, and still dedupe downstream. `previousRunId` gives "find 10 more". It can return richer rows (venue address, price min/max, currency, door time) than search `outputSchema`. Cost per user per night is $0.10–$2 depending on effort. Use `createAndWait(..., { timeoutMs: 15*60_000 })` or create plus a later poll from a Mastra workflow step.

```ts
const run = await exa.agent.runs.create({
  query: "Find up to 25 concerts, film screenings, talks and meetups in Berlin starting between 2026-10-05 and 2026-10-19 " +
         "that a fan of Nils Frahm, Kiasmos and A24 films would like. Verify date and venue on the venue or ticket page.",
  systemPrompt: "One row per performance/screening. Exclude sold-out or cancelled events if stated. Prices as shown on the page; null if not shown.",
  effort: "auto", budget: { maxCostDollars: 2 },
  input: { exclusion: knownEvents.map(e => ({ url: e.url })) },
  outputSchema: { type: "object", required: ["events"], properties: { events: { type: "array", maxItems: 25, items: {
    type: "object", required: ["title", "start", "venue", "url"],
    properties: { title: {type:"string"}, start: {type:"string", format:"date-time"}, venue: {type:"string"},
      address: {type:["string","null"]}, url: {type:"string", format:"uri"}, priceMin: {type:["number","null"]},
      currency: {type:["string","null"]}, kind: {type:"string", enum:["concert","film","talk","meetup","other"]},
      whyMatch: {type:"string"} } } } } },
  metadata: { userId: "u_123" },
});
const done = await exa.agent.runs.pollUntilFinished(run.id, { pollInterval: 4000, timeoutMs: 20 * 60_000 });
```

The Batch API (`POST /batches`, many /search or /agent/runs in one JSONL job) is **Enterprise-only beta** (`Exa-Beta: batches-2026-06-06`) and not available to us (llms-full §batch/quickstart).

---

## 6. Monitors API: `/monitors`, `exa.monitors.*`

Sources: llms-full §monitors/quickstart, §reference/monitors/* (OpenAPI `create-a-monitor.md`), §websets/api/webhooks/verifying-signatures, SDK `SearchMonitorsClient`.

### 6.1 SDK (exposed in 2.25.0 as `exa.monitors`)

```ts
exa.monitors.create(p: CreateSearchMonitorParams): Promise<SearchMonitor & { webhookSecret: string }>; // secret returned ONCE
exa.monitors.get(id) / list({ cursor?, limit?, status? }) / listAll() / getAll()
exa.monitors.update(id, p: UpdateSearchMonitorParams): Promise<SearchMonitor>;  // partial; trigger: null removes schedule; status: "paused"
exa.monitors.delete(id): Promise<SearchMonitor>;
exa.monitors.trigger(id): Promise<{ triggered: boolean }>;   // works when active or paused
exa.monitors.runs.list(monitorId, { cursor?, limit? }) / runs.get(monitorId, runId) / runs.listAll / runs.getAll

interface CreateSearchMonitorParams {
  name?: string;
  search: { query: string; numResults?: number /*1-100*/; includeDomains?: string[]; excludeDomains?: string[]; contents?: ContentsOptions };
  trigger?: { type: "interval"; period: string };   // omit = manual-only
  outputSchema?: Record<string, unknown>;           // same text/object rules & 10-prop limit; default {type:"text"}; object w/o properties = inferred
  metadata?: Record<string, string>;                // echoed in webhook deliveries
  webhook: { url: string; events?: SearchMonitorWebhookEvent[] }; // required
}
// SearchMonitorWebhookEvent = "monitor.created"|"monitor.updated"|"monitor.deleted"|"monitor.run.created"|"monitor.run.completed"
// SearchMonitorStatus = "active"|"paused"|"disabled" (disabled = auto after 10 consecutive auth failures)
// SearchMonitorRun: { id, monitorId, status: "pending"|"running"|"completed"|"failed"|"cancelled", output: { results?, content?, grounding? } | null,
//   failReason: "api_key_invalid"|"insufficient_credits"|"invalid_params"|"rate_limited"|"search_unavailable"|"search_failed"|"internal_error"|null,
//   startedAt, completedAt, failedAt, cancelledAt, durationMs, createdAt, updatedAt }
```
- **[MISMATCH]** The quickstart says `search` "accepts the same options as Exa Search". The API spec and SDK only allow `query, numResults, includeDomains, excludeDomains, contents`. There is no `type`, `systemPrompt`, `userLocation`, `category`, or date filter. `POST /monitors/batch` (bulk delete/pause/unpause, `dry_run` default true) is **not in the SDK**.
- `exa.beta.agent.monitors` (`/agent/monitors`, `Exa-Beta: agent-monitors-2026-08-04`) is a different, **undocumented** SDK-only beta. It keeps an entities × fields table fresh, with dynamic fields "tracked from news" and a cadence like `"12h"`. It might fit venues as entities, but there are no public docs or pricing, so avoid it for the hackathon.

### 6.2 Schedule and semantics

- `period` is a single-unit duration (`"1h"`, `"6h"`, `"1d"`, `"7d"`). The **minimum is 1 h**. The schedule is anchored to creation time and each run may start **up to 30 min late**. Runs never overlap: if the next run starts while one is running, **the previous run is cancelled**.
- Dedupe: each run applies **date-based filtering ("only fetches content since the last run")** and **semantic deduplication against previous outputs**. Write the query as the ongoing signal, e.g. "new concerts announced at Festsaal Kreuzberg". Don't put moving dates in it.
- Gotcha for venues: an evergreen calendar URL (`venue.de/programm`) whose content changes but whose publish date doesn't will likely be **filtered out or deduped**. Monitors catch new pages such as new event pages, news and announcements. They don't catch changes to an existing page.

### 6.3 Webhook delivery

- The URL must be **HTTPS**, publicly reachable (no localhost or private IPs), and the final destination, because **redirects are not followed**. Local dev needs a tunnel.
- If you omit `events`, you get all events (lifecycle + run.created + run.completed). Subscribe to `["monitor.run.completed"]` only.
- Payload (`monitor.run.completed`):
```json
{ "id": "event_...", "object": "event", "type": "monitor.run.completed",
  "data": { "id": "01k...", "monitorId": "01k...", "status": "completed",
    "output": { "results": [{ "title": "...", "url": "..." }], "content": "... or object if outputSchema",
                "grounding": [{ "field": "content", "citations": [{ "title": "...", "url": "..." }], "confidence": "high" }] },
    "failReason": null, "metadata": { "workspace_id": "workspace_123" } },
  "createdAt": "2026-09-05T20:00:00.000Z" }
```
- Signature header: **`Exa-Signature: t=<unix_ts>,v1=<hex>`**. It is **HMAC-SHA256** with key = the monitor's one-time `webhookSecret`, over the message `${t}.${rawBody}`, hex-encoded. Compare in constant time. There may be several `v1=` values (websets doc), so accept if any matches. Websets docs suggest rejecting if `|now − t| > 300 s`. Retry and redelivery behaviour for search-monitor webhooks is **not documented**, so make the handler idempotent on `data.id` and also poll `runs.list` as a fallback.

```ts
import crypto from "node:crypto";
export function verifyExaSignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const parts = header.split(",").map(p => p.split("=") as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || sigs.length === 0 || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"), "hex");
  return sigs.some(s => { const b = Buffer.from(s, "hex"); return b.length === expected.length && crypto.timingSafeEqual(b, expected); });
}
// Hono/Mastra route: const raw = await c.req.text(); verify BEFORE JSON.parse(raw).
```
- Cost: **$15 / 1k requests**, i.e. per run, including up to 10 results. Results above 10 cost $1/1k and summaries $1/1k pages. A daily monitor costs about $0.45/month.

---

## 7. Websets (one paragraph)

Websets (`exa.websets.*`, `/websets/v0/*`) build verified, enriched entity lists asynchronously: a query plus a target count, criteria checks, then enrichments, with their own monitors and webhooks. They need a **separate paid Websets plan** (Search credits don't apply), the free plan caps at 25 items, and Exa now says "starting a new list-building workflow? Use Exa Agent". The flow is minutes long and entity-oriented (companies, people, papers), with no notion of event dates. **Not relevant here.** Use Agent for list-building and Search or Contents for the rest. (llms-full §websets/quickstart)

---

## 8. Pricing, rate limits, errors

Sources: llms-full §admin/pricing, §admin/billing, §admin/error-codes; SDK `ExaError`.

### 8.1 Pricing (pay-as-you-go; free tier = $10 credits/month + one-time $10 onboarding bonus)

| Item | Price |
|---|---|
| `/search` `instant` (≤10 results) | $4 / 1k requests |
| `/search` `auto`, `fast` (≤10 results, contents for those results included) | $7 / 1k |
| `/search` `deep-lite`, `deep` | $12 / 1k |
| `/search` `deep-reasoning` | $15 / 1k |
| Each result above 10 (any search, monitors) | $1 / 1k results |
| AI page summary (`summary`) | $1 / 1k pages |
| `outputSchema` synthesis | no separate line item (verify via `costDollars`) |
| `/contents` | $1 / 1k pages **per content type** |
| `/monitors` run | $15 / 1k runs (+ results above 10, summaries) |
| `/answer` | $5 / 1k |
| Agent fixed effort | minimal $0.012, low $0.025, medium $0.10, high $0.50, xhigh $1.00 per run |
| Agent `auto` / `ultra` (metered) | $0.10/ACU + $0.005/search; caps $5 / $20 (`budget.maxCostDollars` $1–$100) |

Example: chat search `auto` with 10 results and highlights costs $0.007. A nightly `deep` + outputSchema per user costs $0.012. Fetching 20 calendar pages with text costs $0.02, or $0.04 with summary.

### 8.2 Rate limits (team-wide, all keys)

| Endpoint | Default |
|---|---|
| `/search` (instant/fast/auto), `/answer` | 10 QPS (25 QPS for 90 days after buying $1k credits within 30 days) |
| `/search` deep types | 5 QPS |
| `/contents` | 100 QPS |
| `/agent/runs` | 5 QPS (each create = 2 requests) and 50 active runs |
| `/websets/*` | 20 QPS |

### 8.3 Errors worth handling

Error body: `{ requestId, error: string, tag: string }`.

| HTTP | Tag(s) | Action |
|---|---|---|
| 400 | `INVALID_REQUEST_BODY`, `INVALID_REQUEST` (e.g. beta used without header), `INVALID_NUM_RESULTS`, `NUM_RESULTS_EXCEEDED`, `INVALID_JSON_SCHEMA` (outputSchema limits), `SUBPAGES_LIMIT_EXCEEDED`; Agent `INVALID_OUTPUT_SCHEMA` | Fix the request. Don't retry. |
| 401 | `INVALID_API_KEY` | config error |
| 402 | `NO_MORE_CREDITS`, `API_KEY_BUDGET_EXCEEDED`, `TEAM_BUDGET_EXCEEDED` | Alert. Degrade to cached results. |
| 403 | `FEATURE_DISABLED`, `PROHIBITED_CONTENT`, `CONTENT_FILTER_ERROR` | Don't retry. |
| 429 | `RATE_LIMIT_EXCEEDED`; Agent `CONCURRENCY_LIMIT_REACHED` | Honour `Retry-After` if present, else exponential backoff. |
| 500 / 504 | — | Retry once or twice with backoff (504: reduce scope). |
| 503 | `SERVICE_OVERLOADED` | Not billed. Retry with backoff. Lowering your own rate doesn't help. |

**SDK gotchas:** `ExaError` has `statusCode`, `message`, `requestId`, plus `type`/`code`/`detail` **only for the nested envelope** (`{error:{type,code,...}}`, used by monitors and agent). For the standard flat `{error, tag}` body, the **`tag` is not mapped** (it is lost apart from the message text), so branch on `statusCode`. Response headers, including `Retry-After`, are not exposed. There are **no built-in retries or request timeouts** (plain `fetch`, no AbortSignal), so wrap calls yourself:

```ts
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      const s = e instanceof ExaError ? e.statusCode : 0;
      if (i >= tries - 1 || ![429, 500, 503, 504].includes(s)) throw e;
      await new Promise(r => setTimeout(r, 2 ** i * 500 + Math.random() * 250));
    }
  }
}
```

---

## 9. Search best practices for event discovery

Sources: llms-full §search/best-practices, §search/quickstart#writing-queries, §search/data/sports-weather-places, SDK `DEFAULT_WEB_SEARCH_TOOL_DESCRIPTION` ("Describe the ideal page rather than listing keywords").

- **Describe the ideal page in natural language**, not keywords. Include subject, source type, place and time: "Venue event page for a live jazz concert in Berlin-Kreuzberg in mid-October 2026 with date, start time and ticket link" beats "jazz berlin october".
- Use **`objective`** whenever the LLM writes the query: "Find individual upcoming event listings in <city> between <d1> and <d2>; prefer venue/ticketing pages; exclude news, reviews and past events; pull date, time, venue and price." The `exa.tools.webSearch()` helper requires the model to supply this.
- **Time window goes in the query and `systemPrompt`**, never in publish-date filters (they'd exclude calendars published months ago). Validate the event date yourself.
- **Hard constraints only** in `includeDomains`/`excludeDomains`. Use `includeDomains` for a venue-specific search (`["venue.de/programm"]`). Use `excludeDomains` for sources you can never use (e.g. social sites you can't book through). Put soft preferences like "prefer official venue pages" in the query or `systemPrompt`.
- `userLocation` = country code for regional bias. The city must be in the query. Write queries in the local language too when useful (Exa detects the query language and returns results in that language), e.g. run a German "Konzerte Berlin Oktober 2026" alongside the English one.
- Use **highlights for discovery/ranking**, with `highlights.query` aimed at "date time venue price". Use **text only for pages you will extract from** (calendars), via Contents. Request one view per call.
- Latency budget for chat: `fast`/`auto` + highlights ≈ 0.5–1 s, plus outputSchema +2 s, plus `maxAgeHours` live fetch up to 10 s. Keep freshness and synthesis off the interactive path unless needed. `instant` + `maxAgeHours: -1` is the fastest path when cache is acceptable.
- Change one thing at a time when tuning (query → filters → type), log `requestId`/`searchTime`/`costDollars`, and keep a small fixed eval set of queries (e.g. 3 cities × 4 event kinds).
- Common mistakes: `useAutoprompt`, top-level `text/highlights` on /search, `numSentences`/`highlightsPerUrl`, `livecrawl` together with `maxAgeHours`, `includeText`, crawl-date filters.

---

## Recommendations for event discovery

1. **(a) On-demand chat search:** `exa.search(q, { type: "fast" | "auto", numResults: 10, userLocation, objective, contents: { highlights: { query: "date, start time, venue, price" } } })`. Let the Mastra agent read the highlights, rank candidates against the user's taste, and present them. Add `outputSchema` (lean 6–8 field `events[]`, `type: "auto"`) only if you need structured rows inside the chat turn, at about +2 s. Always set `contents` explicitly, because of the SDK default text injection.
2. **(b) Daily discovery batch (per city × kind):** run several `type: "deep"` searches with the 8-field `events[]` `outputSchema`, a strict `systemPrompt` (city, ISO window, one row per showtime, no invented prices) and `additionalQueries` for sub-genres or local-language variants. Store rows with their grounding URLs and confidence. Optionally run one Agent run per active user (`effort: "auto"`, `budget.maxCostDollars` 1–2, `input.exclusion` = known event URLs) for richer, verified rows. Respect 5 QPS for deep and 50 concurrent Agent runs.
3. **(c) Watching favourite venues:** keep a `venues` table with the calendar URL. Run a **daily cron** calling `exa.getContents(calendarUrls, { maxAgeHours: 24, text: { maxCharacters: 40000 } })` (≤100 URLs per call, check `statuses`), extract events with our own LLM (or `summary.schema`), and diff against the DB by `(venue, title, start)`. Use **Monitors only for "new announcement" signals** (`includeDomains: [venueDomain]`, `period: "1d"`, `metadata: { venueId }`, `events: ["monitor.run.completed"]`), because publish-date filtering and semantic dedupe hide changes to evergreen calendar pages.
4. **Calendar-page extraction:** treat search as discovery and extract per page. Fetch the page via Contents (`text` + `maxAgeHours`). If the calendar is split by month or pagination, use `subpages` + `subpageTarget: ["programm","events","calendar","tickets"]`. Run an extractor whose output is one row per showtime with ISO date-time including the year and timezone. Drop rows outside the window in code. Don't rely on the 10-property, multi-source search synthesis for 40-item calendars.
5. **Event identity and dedupe:** normalise on (canonical event URL, or venue + start minute + fuzzy title). Search results, Agent rows and Monitor deliveries will overlap.
6. **Grounding:** persist `output.grounding` next to each row. Show the cited URL as "source". Flag `confidence: "low"` rows for a page check before recommending.
7. **Prices:** treat any price from search, outputSchema, summary or Agent as an **estimate for display only** ("from ~€18"), stored as raw text plus an optional parsed number and currency. At booking time, the browser/Kernel step re-reads the live ticket page, which is the source of truth for price, availability and fees, and the user confirms that price. Never charge or quote a firm price based on Exa output. Use `maxAgeHours: 0` only if you must show a fresher indicative price.
8. **Freshness budget:** the default cache is fine for discovery. Use `maxAgeHours: 24` for calendars and pre-booking re-checks. Avoid `0` on the chat path (up to `livecrawlTimeout`, default 10 s).
9. **Resilience:** wrap every Exa call in a retry and timeout helper (429/500/503/504, exponential backoff), branch on `ExaError.statusCode`, and degrade to DB-cached events on 402 or 5xx.
10. **Cost sanity check:** with 100 users, chat at about 10 searches per user per day costs ~$7/day. A nightly deep pass over 10 cities × 4 kinds costs ~$0.50. Venue calendars (200 URLs/day, text) cost ~$0.20. Agent at $0.10–$2 per user per night is the only line item that scales painfully, so make it opt-in or fixed `medium`.
