# Mastra reference for event search / discovery

Checked on 2026-10-04 against the installed packages: `@mastra/core` 1.74.0, `@mastra/pg` 1.29.0,
`@mastra/memory` 1.35.0, `@mastra/hono` 1.7.16 (`node_modules/@mastra/*/dist/**/*.d.ts`). The docs come
from the cloned repo `refs/repos/mastra-ai_mastra` (core **1.75.0-alpha.3**, docs under
`docs/src/content/en/`). Paths below are relative to those roots. When the docs and the installed
types disagree, this note follows the installed types (see "Mismatches" at the end).

Project conventions (from `src/mastra/**`): Zod 4 schemas (`import { z } from 'zod'`). Steps reach
agents with `mastra.getAgent('<key>')` (the key in `new Mastra({ agents })`, not the agent `id`).
Model strings come from `process.env.MODEL ?? 'neon/claude-sonnet-5'`. Background work on Neon is
wrapped in `waitUntil` from `@neon/functions`. Custom routes use `registerApiRoute` with
`requiresAuth: false`. The Neon entry point (`src/index.ts`) mounts `MastraServer` from `@mastra/hono`
and **does not call `mastra.startWorkers()`**.

---

## 1. Workflows

Import everything from `@mastra/core/workflows`. Types: `dist/workflows/workflow.d.ts`, `types.d.ts`, `step.d.ts`.

### createStep / createWorkflow (installed signatures, trimmed)

```ts
createStep({
  id, description?, inputSchema, outputSchema,
  resumeSchema?, suspendSchema?, stateSchema?, requestContextSchema?,
  retries?: number, scorers?, metadata?,
  execute: (params: ExecuteFunctionParams) => Promise<Output | InnerOutput>,
})
// Other overloads: createStep(agent, { structuredOutput?: { schema }, retries? })  -> input { prompt: string }
//                  createStep(tool, { retries? })   createStep(classifier)   createStep(processor)

createWorkflow({
  id, description?, inputSchema, outputSchema, stateSchema?, requestContextSchema?,
  retryConfig?: { attempts?: number; delay?: number },        // defaults for every step
  options?: WorkflowOptions,   // onFinish, onError, validateInputs, shouldPersistSnapshot, tracingPolicy …
  schedule?: WorkflowScheduleConfig | WorkflowScheduleConfig[],  // cron, see §2
})
```

`ExecuteFunctionParams` (`dist/workflows/step.d.ts`) holds: `inputData`, `mastra: Mastra` (always
set inside a registered workflow), `requestContext: RequestContext`, `runId`, `resourceId?`,
`workflowId`, `state`, `setState(state)`, `getInitData<T>()`, `getStepResult(stepOrId)`,
`suspend(payload, { resumeLabel? })`, `resumeData?`, `suspendData?`, `bail(result)`, `abort()`,
`retryCount`, `abortSignal`, `writer`. It also carries the `ObservabilityContext` fields:
`tracingContext`, `loggerVNext` (trace-correlated logger) and `metrics`.

- **Logger.** No `logger` param exists. Use `mastra.getLogger()` as `workflows/onboard.ts` does, or
  `loggerVNext` for trace-correlated logs.
- **Request context.** Use `requestContext.get('userId')`. To make it typed and validated, set
  `requestContextSchema` on the workflow or step.

### Control flow (`docs/workflows/control-flow.mdx`)

| Method | Next step's `inputData` |
|---|---|
| `.then(step)` | that step's output |
| `.parallel([a, b], opts?)` | `{ [a.id]: outA, [b.id]: outB }` (no concurrency limit; if one throws, the whole block fails) |
| `.foreach(step, { concurrency?: number \| (ctx) => number })` | `Out[]` in input order. **Default concurrency 1** (sequential). The previous output must be an array |
| `.branch([[cond, stepA], [cond, stepB]])` | `{ [executedStep.id]?: out }`. The first true condition wins |
| `.map(fn \| mappingConfig, { id? })` | whatever the mapping returns. `fn` gets the full `ExecuteFunctionParams` |
| `.dowhile/.dountil(step, cond)` | loop. `cond` gets `{ inputData, iterationCount, … }` |
| `.sleep(ms)` / `.sleepUntil(date)` | pass-through |
| `.agent(agentOrId, { structuredOutput? })` / `.tool(toolOrId)` | declarative agent/tool step (installed. Needs input `{ prompt }` for agents) |
| `.commit()` | required at the end |

`ForeachOptions` (`types.d.ts:683`): `{ concurrency: number | ForeachConcurrencyResolver }`, where
the resolver signature is `({ inputData, getInitData }) => number`.

**Passing data.** Data normally flows by chaining output into input. To reach data from
non-adjacent steps, use `getStepResult(stepObj | 'step-id')` and `getInitData()`. For shared mutable
data, use `stateSchema` with `state` / `setState()`; seed it with `run.start({ initialState })`.
`.map(async ({ inputData, getStepResult, getInitData }) => ...)` reshapes data between steps.

```ts
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

const Query = z.object({ q: z.string(), includeDomains: z.array(z.string()).optional() });
const Hit = z.object({ url: z.string(), title: z.string().nullable(), text: z.string().optional() });

const plan = createStep({
  id: 'plan-queries',
  inputSchema: z.object({ userId: z.string() }),
  outputSchema: z.array(Query),
  execute: async ({ inputData, mastra }) => { /* LLM or rules -> queries */ return [{ q: 'jazz concerts SF this week' }]; },
});

const search = createStep({
  id: 'exa-search',
  inputSchema: Query,
  outputSchema: z.object({ hits: z.array(Hit), failed: z.boolean() }),
  retries: 2,                                   // overrides workflow retryConfig for this step
  execute: async ({ inputData, mastra }) => {
    try { return { hits: await exaSearch(inputData), failed: false }; }
    catch (err) { mastra.getLogger().warn('exa failed', { q: inputData.q, err: String(err) }); return { hits: [], failed: true }; }
  },
});

export const discoverEvents = createWorkflow({
  id: 'discover-events',
  inputSchema: z.object({ userId: z.string() }),
  outputSchema: z.object({ suggested: z.number() }),
  retryConfig: { attempts: 2, delay: 1000 },
})
  .then(plan)
  .foreach(search, { concurrency: 4 })                        // -> { hits, failed }[]
  .map(async ({ inputData, getInitData }) => ({
    userId: getInitData<{ userId: string }>().userId,
    hits: inputData.flatMap(r => r.hits),
  }))
  .then(extract) /* .then(dedupeStore).then(score).then(decide).then(notify) */
  .commit();
```

### Running a workflow (`Workflow` / `Run` in `workflow.d.ts`)

```ts
const wf = mastra.getWorkflow('discoverEvents');                         // config key; or getWorkflowById('discover-events')
const run = await wf.createRun({ runId?, resourceId? });                 // createRun is async
const res = await run.start({ inputData, initialState?, requestContext?, outputOptions?, perStep? });
const { runId } = await run.startAsync({ inputData, requestContext });   // fire-and-forget (see note)
const out = run.stream({ inputData, requestContext, closeOnSuspend? });  // WorkflowRunOutput; iterate events, await result
await run.cancel();
await wf.getWorkflowRunById(runId);                                      // persisted state (WorkflowState | null)
await wf.listWorkflowRuns({ ... });  await wf.listActiveWorkflowRuns();  await wf.restartAllActiveWorkflowRuns();
```

`WorkflowResult` (`types.d.ts:887`) is a union discriminated on `status`:

- `'success'` has `result`.
- `'failed'` has `error: Error`.
- `'suspended'` has `suspendPayload` and `suspended: string[][]`.
- `'tripwire'` has `tripwire`.
- `'paused'` exists as well.

Every variant also has `input`, `steps[stepId]` (each with `status`, `output`, `payload`, `error?`,
`startedAt`, `endedAt`), `state?` and `stepExecutionPath?`. `start()` doesn't throw on step failure:
check `res.status`.

**`startAsync` detail.** In the installed `agent-CnrRF71P.js`, `startAsync` launches `_start()`,
resolves once the run has dispatched, and leaves the execution promise running in-process. Errors are
only logged. On Neon Functions the isolate can freeze after the response, so prefer
`waitUntil(run.start(...))`.

**Errors and retries** (`docs/workflows/error-handling.mdx`):

- `retryConfig { attempts, delay }` is the workflow-wide default. A step's `retries` overrides it.
  `retryCount` is passed into `execute`.
- A step that throws marks the run `failed`. `bail(value)` ends the workflow successfully with that
  output.
- `MastraNonRetryableError` (exported from `@mastra/core/error`) skips retries. The step result then
  carries `nonRetryable: true`.
- `options.onFinish(result)` and `options.onError(info)` both receive `{ status, result|error, steps,
  runId, workflowId, resourceId, getInitData, mastra, requestContext, logger, state }`. Errors thrown
  inside these callbacks are swallowed.

### Suspend / resume basics

```ts
const approve = createStep({
  id: 'approve', inputSchema: X, outputSchema: Y,
  suspendSchema: z.object({ question: z.string() }),
  resumeSchema: z.object({ ok: z.boolean() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData) return suspend({ question: 'Book it?' }, { resumeLabel: 'approval' });
    return { ... };
  },
});
// later (e.g. from the WhatsApp webhook):
const run = await mastra.getWorkflow('x').createRun({ runId });   // rehydrate by runId
await run.resume({ step: 'approve', resumeData: { ok: true } });   // or { label: 'approval' }
```

### Where runs are stored

Snapshots are written to the Mastra storage, which is `PostgresStore` in `src/mastra/index.ts`, in
the table **`mastra_workflow_snapshot`** (`TABLE_WORKFLOW_SNAPSHOT`, `dist/storage/constants.d.ts`).
The local DB already contains this table with an `onboard-user` row. Snapshots are written on every
status transition, not only when a run suspends. `options.shouldPersistSnapshot` can reduce writes.
Runs are visible in Studio (`mastra dev`), via `wf.listWorkflowRuns()`, and at
`GET /api/workflows/:workflowId/runs`.

---

## 2. Scheduling: there IS a built-in cron scheduler in 1.74

Sources: `dist/workflows/scheduler/{types,scheduler}.d.ts`, `dist/schedules/*.d.ts`,
`dist/mastra/index.d.ts` (`scheduler?`, `schedules`), `docs/workflows/scheduled-workflows.mdx`,
`docs/deployment/workers.mdx`, `docs/harness/schedules.mdx`, `docs/server/server-adapters.mdx`
("Start background workers").

### Declarative (on the workflow)

```ts
export const discoverEvents = createWorkflow({
  id: 'discover-events',
  inputSchema: z.object({ userId: z.string().optional() }),
  outputSchema: ...,
  schedule: {                                  // or an array; then every entry needs a stable `id`
    cron: '0 8 * * *',                         // 5-, 6- or 7-part. Validated at construction
    timezone: 'America/Los_Angeles',           // IANA. Defaults to the HOST timezone
    inputData: {},                             // type-checked against inputSchema
    initialState?: ..., requestContext?: { ... }, metadata?: { ... },
  },
}).then(...).commit();
```

- The schedule row id is `wf_<workflowId>`, or `wf_<workflowId>__<scheduleId>` for array entries.
  Rows are synced at boot. Removing an entry deletes its row. A user-set `paused` status survives
  redeploys.
- Imperative API: `mastra.schedules.create({ workflowId, cron, timezone?, inputData?, requestContext?, resourceId?, id? })`
  creates a `schedule_<slug>` row. The service also offers `list`, `get`, `update`, `pause`, `resume`
  and `delete`, and `run(id)` fires a schedule manually now.
- Agent schedules: `mastra.schedules.create({ agentId, cron, prompt, threadId?, resourceId? })`
  creates an `agent_…` row and wakes or messages an agent on a cron.
- Config: `new Mastra({ scheduler?: { enabled?, tickIntervalMs = 10_000, batchSize = 100, onError?, missesBeforeDelete = 3 } })`.
  The scheduler auto-enables when any workflow declares `schedule` or schedule rows exist.
- Storage: `@mastra/pg` implements the `schedules` domain. Its tables, **`mastra_schedules`** (id,
  target jsonb, cron, timezone, status, next_fire_at, last_fire_at, last_run_id, …) and
  **`mastra_schedule_triggers`** (fire history), already exist in the local DB.
- Mechanics: a `setInterval` tick polls due rows and claims each fire with compare-and-swap on
  `nextFireAt` (so only one instance claims a fire). It then publishes `workflow.start` on the
  in-process pubsub, and the run executes in the same process. The docs still say "don't run more
  than one scheduler instance".
- Studio shows schedules at `/workflows/schedules`. HTTP: `POST /api/schedules/:id/pause|resume`.

### Where it actually fires

| Runtime | Fires? | Why |
|---|---|---|
| `mastra dev` / `mastra build` server (the systemd `booking-agent` service on Sojourner) | **Yes** | `@mastra/deployer` server calls `mastra.startWorkers()` after listen (`deployer/dist/server/index.js:4751`) |
| Neon Function (`src/index.ts`, `@mastra/hono` `MastraServer`) | **No** | Server adapters don't start workers (no `startWorkers` in `@mastra/hono` or `@mastra/server`). Even if you called it, the isolate scales to zero and the tick loop stops. The docs say explicitly that serverless platforms "don't fire with the built-in scheduler today" |

**For Neon, use Neon Function Triggers**, launched 2026-09
(https://neon.com/docs/compute/functions/triggers/schedule.md):

- Neon sends an unauthenticated `POST` to `function_path` (default `/`) of the function, with JSON
  body `{ data: { scheduled_at }, trigger, invocation_id }` and header `X-Neon-Trigger-Invocation-Id`.
  Neon strips client-set `X-Neon-*` headers, so the header proves the call came from Neon.
- Cron has 5 numeric fields and is **UTC only**: no names, no `@daily`, no seconds.
- The trigger keeps working when the compute is scaled to zero.
- Create the trigger in any of these ways:
  - `neon triggers create --function-slug agent --name daily-discovery --cron '0 15 * * *' --function-path /cron/discover`
  - the Neon API: `POST /projects/{id}/branches/{branch}/triggers`, available as the atmOS Neon MCP
    tool `create_trigger`
  - `neon.ts`: `triggers: { 'daily-discovery': { type: 'schedule', function: 'agent', cron: '0 15 * * *' } }`
    (the docs example omits `function_path`, so check that field before using it there)
- Keep the handler idempotent (redelivery is possible). It must *start* responding within 15 min.

Other options: external cron (GitHub Actions, cron-job.org) hitting the same route with a secret,
or Inngest (`@mastra/inngest`, its own cron). `pg_cron` is the wrong tool because it doesn't run
while the compute is suspended.

**Recommended setup:** keep `schedule` *off* the workflow, or accept that it only fires on
Sojourner. Expose one route that both Neon's trigger and a manual "run now" call can hit:

```ts
// src/mastra/routes/discovery.ts
import { registerApiRoute } from '@mastra/core/server';
import { RequestContext } from '@mastra/core/request-context';
import { waitUntil } from '@neon/functions';

export const cronDiscover = registerApiRoute('/cron/discover', {
  method: 'POST',
  requiresAuth: false,
  handler: async c => {
    const fromNeon = !!c.req.header('x-neon-trigger-invocation-id');
    const fromUs = c.req.header('authorization') === `Bearer ${process.env.CRON_SECRET}`;
    if (!fromNeon && !fromUs) return c.text('forbidden', 403);
    const mastra = c.get('mastra');
    const body = await c.req.json().catch(() => ({}));
    const userIds: string[] = body.userId ? [body.userId] : await listActiveUserIds();
    const wf = mastra.getWorkflow('discoverEvents');
    const runs = await Promise.all(userIds.map(async userId => {
      const run = await wf.createRun({ resourceId: userId });
      waitUntil(run.start({ inputData: { userId }, requestContext: new RequestContext([['userId', userId]]) })
        .then(r => r.status !== 'success' && mastra.getLogger().error('discover failed', { userId, status: r.status }))
        .catch(err => mastra.getLogger().error('discover crashed', { userId, err: String(err) })));
      return run.runId;
    }));
    return c.json({ ok: true, runs }, 202);
  },
});
```

`waitUntil` is a no-op under `mastra dev`, as the comment in `routes/whatsapp.ts` notes. The promise
still runs because that process is long-lived.

---

## 3. Agents

Types: `dist/agent/agent.d.ts:1297+`, `agent.types.d.ts`, `types.d.ts:441-500`. Docs:
`docs/agents/structured-output.mdx`.

### Structured output: the option is `structuredOutput: { schema }` and the result is `result.object`

```ts
generate(messages, options: AgentExecutionOptionsBase<T> & { structuredOutput: PublicStructuredOutputOptions<T>; model?: … }): Promise<FullOutput<T>>
```

`PublicStructuredOutputOptions<T>` has the following fields:

- `schema`: Zod, JSON Schema or Standard Schema.
- `model?`: runs a separate structuring pass with a second model.
- `instructions?`
- `useAgent?`
- `jsonPromptInjection?: boolean | 'system' | 'inline' | 'auto'`. Leaving it unset or `false` uses
  the provider's native response format.
- `providerOptions?`
- `logger?`
- `errorStrategy?: 'strict' | 'warn' | 'fallback'` plus `fallbackValue`.

`FullOutput<T>` (`dist/stream/base/output.d.ts:41`) holds `text`, `object: T`, `usedFallbackValue`,
`toolCalls`, `toolResults`, `usage`, `totalUsage`, `finishReason`, `error`, `tripwire`, `traceId`,
`runId` and `messages`. `stream()` takes the same option, and there `await stream.object` gives the
result. There is no top-level `output` or `experimental_output` option on `generate` in 1.74; the
step-factory types explicitly omit `output`. `workflows/onboard.ts` already uses the correct form.

```ts
const Scored = z.object({ items: z.array(z.object({ eventId: z.string(), score: z.number().min(0).max(1), reason: z.string() })) });
const res = await mastra.getAgent('analyst').generate(prompt, {
  structuredOutput: { schema: Scored, errorStrategy: 'fallback', fallbackValue: { items: [] } },
  requestContext,                     // forwards to dynamic instructions/tools
  modelSettings: { temperature: 0 },
  maxSteps: 1,                        // no tool loop for a pure scoring call
});
res.object.items;
```

Structured output with `neon/claude-*` is untested here. Mastra routes `neon/` through the
OpenAI-compatible `/chat/completions` endpoint (`models/gateways/neon.mdx`). If the native JSON
response format is rejected or ignored, set `jsonPromptInjection: 'auto'` (or `true`), or use a
`neon/gpt-5-mini` / `gemini-3-flash` model for extraction.

### Other useful generate options

`requestContext`, `memory: { thread, resource }`, `instructions` (overrides the agent's for this
call), `system`, `context`, `maxSteps`, `stopWhen`, `toolChoice`, `activeTools`, `toolsets`,
`modelSettings`, `providerOptions`, `abortSignal`, `onFinish`, `onStepFinish`, `runId`, `scorers`,
`serverless: { waitUntil }` (keeps finish-time work such as title generation alive on serverless),
and a per-call `model` override.

### Calling an agent from a step or tool

- In a step: `mastra.getAgent('analyst').generate(…, { requestContext })`. Pass the step's
  `requestContext` through; `onboard.ts` shows the pattern.
- In a tool: `context.mastra?.getAgent('analyst')`. `mastra` is optional in the tool context type
  (see §4).
- As a declarative step: `createStep(agent, { structuredOutput: { schema } })` or
  `.agent(agent, { structuredOutput: { schema } })`. Both expect the input `{ prompt: string }`, so
  put a `.map()` in front.
- Workflows as tools for an agent: `new Agent({ …, workflows: { discoverEvents } })` exposes the tool
  `workflow-discoverEvents` (`docs/agents/tools.mdx`). Give the workflow a `description`.

### One-off structured extraction without a registered agent

No `mastra.generate()` helper exists, and the `ai` package is **not** a direct dependency, so
`generateObject` is unavailable unless you add it. Options:

1. **Inline, unregistered Agent.** Cheapest; it works anywhere. It doesn't inherit the Mastra
   logger or storage unless registered, which is fine for stateless extraction.
   ```ts
   const extractor = new Agent({ id: 'extractor', name: 'Extractor', model: process.env.EXTRACT_MODEL ?? 'neon/gpt-5-mini',
     instructions: 'Extract events. Never invent prices or dates; use null when absent.' });
   const { object } = await extractor.generate(pageText, { structuredOutput: { schema: EventList } });
   ```
   Better still, register it in `new Mastra({ agents: { …, extractor } })` so traces show up in Studio.
2. `ModelRouterLanguageModel` (`@mastra/core/llm`) is an AI-SDK v2 `LanguageModel` built from a
   model string. Use it only together with an `ai` SDK call.

### Model strings and environment variables

- **Format:** `provider/model`, for example `neon/claude-sonnet-5`. The Mastra gateway uses
  `mastra/<provider>/<model>`, for example `mastra/openai/gpt-5-mini`.
- **The `neon/` provider** (`dist/provider-registry.json`):
  - It is a models.dev provider with URL `${NEON_AI_GATEWAY_BASE_URL}/v1` and key
    `NEON_AI_GATEWAY_TOKEN` (an `Authorization` header). Both variables are injected inside a Neon
    Function, and `neon env pull` writes them locally.
  - Some GPT models are overridden to `${NEON_AI_GATEWAY_BASE_URL}/openai/v1` (Responses API). You
    can force a base URL with `NEON_BASE_URL` (the generic `<PROVIDER>_BASE_URL` override).
  - The registry lists 47 chat models, among them `claude-sonnet-5`, `claude-haiku-4-5`,
    `gpt-5-mini`, `gpt-5-nano`, `gemini-3-flash`, `gemini-3-5-flash-lite`, `gpt-oss-120b` and
    `qwen3-next-80b-a3b-instruct`. **No embedding models are in this list.**
- **The `mastra/` gateway** (`dist/llm/model/gateways/mastra.d.ts`): set `MASTRA_GATEWAY_API_KEY`.
  `MASTRA_GATEWAY_URL` is optional and defaults to `https://gateway-api.mastra.ai`, with `/v1`
  appended.

---

## 4. Tools

Types: `dist/tools/tool.d.ts:310`, `dist/tools/types.d.ts:525-700`. Docs: `docs/agents/tools.mdx`,
`reference/tools/create-tool.mdx`.

```ts
createTool({
  id, description, title?,
  inputSchema?, outputSchema?, suspendSchema?, resumeSchema?, requestContextSchema?,
  requireApproval?: boolean | ((input, { requestContext?, workspace? }) => boolean | Promise<boolean>),
  strict?, providerOptions?, inputExamples?, toModelOutput?(output), transform?, background?,
  onInputStart?, onInputDelta?, onInputAvailable?, onOutput?,
  execute?: (inputData, context) => Promise<Output | ValidationError | void>,
})
```

- **`execute` signature.** It is `execute(inputData, context)`; the docs call this "exactly one
  signature". `inputData` is validated against `inputSchema`. The `context` holds:
  - `requestContext`, which is always present (an empty one if none was passed)
  - `mastra?: MastraUnion` (optional, hence `context.mastra!`)
  - `abortSignal?`
  - `writer?`, `agent?`, `workflow?`, `suspend?`, `resumeData?`
  - `observe` (`observe.log`, `observe.span`)
  - the tracing fields
- **Errors.** If input validation fails, the model receives a `ValidationError`
  `{ error: true, message, validationErrors }` instead of a run. If `execute` throws, the error
  becomes a `tool-error` result that the model sees, and the agent loop continues. Return
  `{ error: '…' }`-style objects when you want the model to recover gracefully. `afterToolCall`
  hooks get `error` and re-throw.

### A tool that starts a workflow run

```ts
export const findEvents = createTool({
  id: 'find-events',
  description: 'Search for upcoming events matching a request (e.g. "jazz this weekend"). Returns stored, deduped events with links.',
  inputSchema: z.object({ request: z.string(), from: z.string().optional(), to: z.string().optional() }),
  outputSchema: z.object({ events: z.array(EventCard), note: z.string().optional() }),
  execute: async ({ request, from, to }, { mastra, requestContext }) => {
    const userId = String(requestContext.get('userId'));
    const run = await mastra!.getWorkflow('discoverEvents').createRun({ resourceId: userId });
    const res = await run.start({ inputData: { userId, request, from, to, notify: false }, requestContext });
    if (res.status !== 'success') return { events: [], note: `search failed: ${res.status === 'failed' ? res.error.message : res.status}` };
    return { events: res.result.events };
  },
});
```

Keep in mind that WhatsApp turns run inside `waitUntil` with Twilio already answered, so a
synchronous run of 20–60 s is acceptable. To return quickly, query the `events` table first and
only fall back to a live search.

---

## 5. Custom API routes

Types: `dist/server/index.d.ts`. Docs: `docs/server/custom-api-routes.mdx`.

```ts
registerApiRoute<P extends string>(path: P, {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'ALL',
  handler?: (c: HonoContext<{ Variables: { mastra: Mastra; requestContext: RequestContext } }>) => Response | Promise<Response>,
  createHandler?: ({ mastra }) => Promise<ApiRouteHandler>,
  middleware?, cors?, openapi?,
  requiresAuth?: boolean,     // default true, which only matters once server auth is configured
  requiresPermission?, fga?,
}): ApiRoute
```

- Inside a handler: `c.get('mastra')`, `c.get('requestContext')`, `c.req.json()`,
  `c.req.parseBody()`, `c.req.header()`, `c.req.param('id')`.
- Routes mount at the server root, as `/webhooks/whatsapp` does. Mastra's own API lives under
  `/api`.
- Register routes in `new Mastra({ server: { apiRoutes: [...] } })`. `@mastra/hono` `MastraServer`
  mounts them on Neon as well.
- `createRoute()` from `@mastra/server/server-adapter` adds Zod body/query validation. It is
  optional.
- **Security.** No auth is configured, so the built-in `/api/workflows/:id/start|start-async|create-run|resume`
  and `/api/agents/*` routes are publicly callable on the Neon URL. Guard the custom cron and
  webhook routes yourself, using the Neon header, a bearer secret, or a webhook signature.

Exa Monitors webhook skeleton:

```ts
export const exaWebhook = registerApiRoute('/webhooks/exa', {
  method: 'POST', requiresAuth: false,
  handler: async c => {
    const raw = await c.req.text();
    if (!verifyExaSignature(c.req.header('<exa-signature-header>'), raw)) return c.text('bad sig', 401); // see Exa docs
    const payload = JSON.parse(raw);
    const mastra = c.get('mastra');
    waitUntil(ingestMonitorResults(mastra, payload));   // store + score; must be idempotent
    return c.json({ ok: true });
  },
});
```

---

## 6. Search and dedupe built-ins (RAG, vectors, embeddings)

- **`PgVector`** (`@mastra/pg`, `dist/vector/index.d.ts`):
  - Construct it with `new PgVector({ id, connectionString, schemaName?, pgPoolOptions? })`.
  - Methods: `createIndex({ indexName, dimension, metric?: 'cosine'|'euclidean'|'dotproduct', indexConfig?, vectorType?: 'vector'|'halfvec'|'bit'|'sparsevec', metadataIndexes? })`,
    `upsert({ indexName, vectors, metadata?, ids?, namespace? })`,
    `query({ indexName, queryVector, topK, filter?, minScore?, includeVector? })` (returns `{ id, score, metadata }[]`),
    `updateVector`, `deleteVector(s)`, `listIndexes`, `describeIndex`.
  - It manages its own tables. Register it via `new Mastra({ vectors: { pg } })` and fetch it with
    `mastra.getVector('pg')`.
  - It doesn't fit our `events` table, which has its own `embedding vector(1536)` column. For
    dedupe, plain SQL with pgvector (`ORDER BY embedding <=> $1 LIMIT 5`) on `events` is simpler.
- **`ModelRouterEmbeddingModel`** (`@mastra/core/llm`, `dist/llm/model/embedding-router.d.ts`):
  - It is an AI-SDK v2 embedding model. Call `doEmbed({ values })` and read `{ embeddings }`.
    Batches go up to `maxEmbeddingsPerCall`. `embedV2` is re-exported from `@mastra/core/vector`.
  - The docs' `embedMany` from `'ai'` is not installed here.
  - Verified locally with a stubbed `fetch`:
    - `'mastra/openai/text-embedding-3-small'` **works**. It posts to
      `https://gateway-api.mastra.ai/v1/embeddings` with `MASTRA_GATEWAY_API_KEY` and returns 1536
      dimensions, matching `events.embedding`.
    - `'neon/qwen3-embedding-0-6b'` **fails with "Invalid URL"**. The embedding router doesn't
      interpolate the registry's `${NEON_AI_GATEWAY_BASE_URL}` template (the chat path does), and
      the Neon registry has no embedding models.
    - **Workaround that works:**
      ```ts
      const embedder = new ModelRouterEmbeddingModel({ providerId: 'neon', modelId: 'qwen3-embedding-0-6b',
        url: `${process.env.NEON_AI_GATEWAY_BASE_URL}/v1`, apiKey: process.env.NEON_AI_GATEWAY_TOKEN });
      const { embeddings } = await embedder.doEmbed({ values: texts });   // POST {base}/v1/embeddings
      ```
  - Neon AI Gateway embeddings (neon.com/docs/ai-gateway/embeddings, 2026-10):
    - Models: `qwen3-embedding-0-6b` (1024 dimensions, normalized, $0.02/M) and `gte-large-en`
      (1024 dimensions, not normalized).
    - Batches go up to 150 inputs.
    - **1024 ≠ the schema's `vector(1536)`**: either change the column to `vector(1024)` or use
      `mastra/openai/text-embedding-3-small`.
- `@mastra/core/relevance` provides `MastraAgentRelevanceScorer(name, model).getRelevanceScore(query, text)`,
  which returns a number. It is a tiny LLM reranker meant for `@mastra/rag`, and `@mastra/rag` isn't
  installed.
- `@mastra/memory` semantic recall is chat-memory only and doesn't help with event dedupe.

**Dedupe advice:**

1. Normalize the URL first (strip `utm_*`, `ref`, fragments, trailing `/`), using `events.source_url UNIQUE`.
2. Then match on a key: lowercased title + `date(starts_at)` + venue.
3. Only then use embeddings (cosine > ~0.9 on `title + venue + date`) for cross-site duplicates such
   as an Eventbrite and a venue page for the same event.

---

## 7. Evals / scorers (short)

`createScorer({ id, description, judge?: { model, instructions } })` from `@mastra/core/evals`
(`dist/evals/base.d.ts:424`) has a chain of `.preprocess().analyze().generateScore().generateReason()`.
Each step is a function or an LLM "prompt object". Attach scorers to agents or steps via
`scorers: { … }`; results go to `mastra_scorers` and show in Studio. For relevance, the cheap path is
**not** a scorer: score inside the workflow with one batched `generate({ structuredOutput })` call
per user. A scorer only pays off for offline checks of past suggestions, for example with a
`feedback` dataset. Docs: `docs/evals/custom-scorers.mdx`.

---

## Mismatches and gotchas (docs vs installed)

1. **Version skew.** The cloned repo is core 1.75.0-alpha.3 and the installed core is 1.74.0.
   Everything above was checked in the installed `.d.ts` files.
2. **Snapshot table name.** `docs/workflows/snapshots.mdx` says `workflow_snapshots`, but the
   installed `@mastra/pg` uses `mastra_workflow_snapshot`.
3. **Scheduler storage.** The `Mastra` JSDoc names `@mastra/libsql` as the storage for the
   scheduler, but `@mastra/pg` 1.29 implements `mastra_schedules` and `mastra_schedule_triggers` too.
4. **Duplicate schedulers.** The docs say "don't run more than one scheduler". The code claims each
   fire with compare-and-swap, so duplicates are unlikely but still discouraged. If Sojourner's
   `mastra dev` and Neon ever share one DB, only Sojourner runs the scheduler, and it runs the
   workflow on Sojourner.
5. **Embeddings.** The docs use `embedMany` from `ai`, which isn't a dependency here; use
   `doEmbed`. `neon/<embedding>` strings are broken in 1.74 (see §6).
6. **Server adapters.** `server-adapters.mdx` notes that adapters (our Neon entry) need
   `mastra.startWorkers()` for schedules and event listeners. It is pointless on scale-to-zero
   isolates anyway.
7. **`startAsync`.** The HTTP `/start-async` awaits the full result, but core `run.startAsync()`
   doesn't (see the JSDoc on `resumeAsync`).
8. **`timezone`.** It defaults to the host timezone in Mastra, while Neon cron is always UTC.

---

## Recommendations

1. **Workflow shape.**
   `discover-events` = `plan-queries` (LLM with `structuredOutput`, `maxSteps: 1`; returns 4–8 Exa
   queries from the taste profile, city and date window) → `.foreach(exa-search, { concurrency: 4 })`
   (try/catch inside, `retries: 2`, return `{hits, failed}`) → `.map` flatten → `extract` →
   `dedupe-store` → `score` → `decide` → `notify`.
   - `extract`: a cheap model such as `neon/gpt-5-mini`, with `structuredOutput` and
     `errorStrategy: 'fallback'`, batched 5–10 pages per call. Leave `price` null unless the page
     states it, as the schema comment requires.
   - `dedupe-store`: URL normalization, then `INSERT … ON CONFLICT (source_url) DO NOTHING`.
   - `score`: one batched structured call per user against `tasteForPrompt()`.
   - `decide`: `policy.ts` thresholds.
   - `notify`: WhatsApp.
   - Give each step's input and output a Zod schema, so Studio shows clean step I/O.
2. **Fan-out primitive.** Use `.foreach` with `concurrency`, not `.parallel`, for N queries:
   `.parallel` takes a fixed step list keyed by id and has no concurrency limit. Never let one
   failing Exa call fail the run.
3. **Data from earlier steps.** Carry `userId` with `getInitData()` or in `stateSchema` instead of
   threading it through every schema. Pass `requestContext` with `userId` so agent instructions,
   which read `requestContext.get('userId')`, work in steps.
4. **Daily trigger on Neon.** Add a Neon schedule trigger (UTC cron, e.g. `0 15 * * *` ≈ 08:00 PT)
   pointing at `POST /cron/discover`. Use the route from §2: check `X-Neon-Trigger-Invocation-Id`
   or a `CRON_SECRET` bearer, run once per active user, wrap in `waitUntil`, and return 202.
   - Make it idempotent with a `discovery_runs(user_id, day)` unique row, or by checking
     `listWorkflowRuns` for today.
   - Optionally also declare `schedule` on the workflow for the Sojourner `mastra dev` box. Its
     input must then work without a userId (loop over users inside), and it must not double-fire if
     both environments point at the same DB.
5. **"Run discovery now".** Use the same route with `{ userId }` in the body. Optionally add an
   `/webhooks/exa` route for Exa Monitors that feeds new results straight into `dedupe-store` →
   `score`, skipping the plan and search steps. A small second workflow, `ingest-hits`, reused as
   the tail of `discover-events`, keeps that DRY.
6. **`find-events` tool for the concierge.**
   - First query the `events` table for future events matching the city, joined with `suggestions`
     for this user. If there are fewer than about 3 good hits, start the workflow with
     `notify: false` and `await run.start()` (see §4).
   - Return a compact list (title, date, venue, price or null, url, score, reason).
   - Use `toModelOutput` to keep the model context small.
7. **Structured output.** Use `structuredOutput: { schema, errorStrategy: 'fallback', fallbackValue }`
   everywhere, so one bad generation doesn't fail the run. If `neon/claude-*` ignores the JSON
   format, add `jsonPromptInjection: 'auto'`. Register the extractor and scorer agents on `Mastra`
   so their calls show up in Studio traces.
8. **Embeddings.** Use them only for cross-site dedupe and "more like this":
   - either `mastra/openai/text-embedding-3-small` (1536, fits the current schema, needs
     `MASTRA_GATEWAY_API_KEY`)
   - or Neon `qwen3-embedding-0-6b` via the object config in §6, with the column migrated to
     `vector(1024)`. Decide before the first insert.
9. **Results and alerting.** Check `res.status` after every `run.start`. Log failures with
   `mastra.getLogger()`. Add `options.onError` on the workflow for one central alert log. Runs and
   step I/O are inspectable in `mastra_workflow_snapshot` and Studio.
