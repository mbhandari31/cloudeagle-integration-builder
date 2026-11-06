# AI Integration Builder prototype: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A static web app on GitHub Pages that turns an OpenAPI spec into a sandboxed, tested, read-only users-and-usage connector using Claude, with a replay mode that needs no key.

**Architecture:** Plain ES modules shared by browser and Node. The pipeline (`src/pipeline.js`) wires the parts together:

- spec tools (`src/spec/`),
- an AI client with live and replay modes (`src/ai/`),
- a sandbox (`src/sandbox/`): static checks, transpile, mock transport, execution core, validation.

The browser runs connectors in a Web Worker; Node runs them in `vm`.

**Tech Stack:** Node 22 (`node --test`), `@anthropic-ai/sdk@1.4.0`, `js-yaml@4.1.0`, `sucrase@3.35.0`. The browser loads all three from `cdn.jsdelivr.net/npm/<pkg>@<ver>/+esm` through an import map. There is no bundler.

**Spec:** `docs/superpowers/specs/2026-11-06-integration-builder-prototype-design.md`

## Global constraints

- Models: triage `claude-haiku-5-5` (effort `low`). Generate and repair `claude-sonnet-5-5` (effort `medium`, `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`, via `client.beta.messages.create`).
- Always check `stop_reason === "refusal"` before reading content. A refusal throws `AiRefusalError`.
- No API key in any committed file. `.gitignore` covers `node_modules/` and `.env*`.
- Generated code may import only `@cloudeagle/connector-sdk`. The runtime allows `GET` only, to `https://<planned host>` only.
- Sandbox limits: 50 pages per path, 5,000 records per stream, 15 s wall-clock per run.
- Repair loop: at most 3 rounds after the first generation.
- Mock pool: 48 people, the first 37 active. Fixed clock in tests: `2026-11-06T00:00:00Z`.
- Labels: the UI states "Prototype: sandbox runs on synthetic data generated from the API spec".

## Connector contract (shared by prompts, runtime, tests)

```ts
import { defineConnector, http, paginate, log } from "@cloudeagle/connector-sdk";
export default defineConnector({
  app: string, baseUrl: string,
  auth: { type: "oauth2"|"bearer"|"api_key"|"basic", scopes: string[] },
  async *users(ctx) { /* yields { email, name?, role?, externalId? } */ },
  async *usage(ctx) { /* yields { email, at /* ISO 8601 */ } */ },
});
```

- `ctx = { since: ISOString /* now − 90 days */, state: {} }`. The same `ctx` object goes to `users` and then to `usage`, so `users` can stash the org in `ctx.state`.
- `http.get(path, query?) -> Promise<json>`
- `paginate(path, { query?, next: (res) => token|null, tokenParam?: "page_token", items: (res) => array, map?: (item) => record|record[] })` is an async generator.
- Citations are trailing comments of the form `// source: <METHOD path | spec section>`.

## Review focus

1. **A spec with no examples or missing schemas** (an empty response schema). The mock still returns `{}` and the run reports "no users found" as a validation error. It does not crash. *Test in Task 2.*
2. **Generated code that never terminates pagination** (a `next` that always returns a token). It stops at the 50-page cap with a clear error. *Test in Task 4.*
3. **The model returns prose with no code block, or truncated code** (`max_tokens`). This becomes a generation error that goes into the repair loop. It does not throw out of the pipeline. *Test in Task 6.*
4. **A spec URL that fails CORS or isn't OpenAPI** (an HTML docs page). The UI shows "Couldn't read an OpenAPI spec at this URL" with a hint to paste a spec URL. *Test in Task 1.*
5. **Escape attempts in generated code**: `globalThis.fetch`, `({}).constructor.constructor`, `import("...")`, a POST via `http`. Static checks flag them, and the runtime blocks them anyway. *Tests in Task 3.*

---

### Task 1: Repo scaffold, spec loading and summarising

**Files:**
- Create: `package.json`, `.gitignore`, `src/spec/load.js`, `src/spec/refs.js`, `src/spec/summarize.js`, `src/spec/slice.js`, `test/spec.test.js`

**Interfaces:**
- Produces:
  - `parseSpec(text: string) -> object`: JSON or YAML; throws `SpecError` if there is no `openapi`/`swagger` key.
  - `loadSpec(url, fetchImpl=fetch) -> Promise<object>`: wraps network and parse failures in `SpecError("Couldn't read an OpenAPI spec at this URL")`.
  - `resolveRef(spec, ref) -> object`
  - `deref(spec, node, depth=6) -> object`: resolves `$ref`, cycle-safe.
  - `summarizeSpec(spec) -> { title, servers: string[], security: object, endpoints: [{ method, path, summary, scopes: string[], params: string[] }] }`
  - `sliceSpec(spec, endpoints: [{method,path}]) -> object`: dereferenced operations plus the servers and securitySchemes.

- [ ] **Step 1:** `package.json` with `"type": "module"`, a `test` script `node --test test/`, and devDependencies pinned per the tech stack. Run `npm install`.
- [ ] **Step 2: Write failing tests** in `test/spec.test.js` against `fixtures/calendly-api.yaml`:
  - `summarizeSpec(...).endpoints.length === 65`
  - `servers` includes `"https://api.calendly.com"`
  - the `GET /organization_memberships` entry has `scopes` including `"organizations:read"`
  - `sliceSpec(spec, [{method:"get", path:"/organization_memberships"}])` JSON contains `"next_page_token"` and no `"$ref"`
  - `parseSpec("<html>")` throws `SpecError`
  - `loadSpec` with a fetch stub that rejects throws `SpecError`
- [ ] **Step 3:** Run `npm test` and expect it to FAIL (modules missing).
- [ ] **Step 4:** Implement. Scopes are parsed from the description text matching ``/`([a-z_]+:read|[a-z_]+:write)`/g``. Write `summarize` output compactly; it is fed to Haiku.
- [ ] **Step 5:** Run `npm test` and expect PASS. Commit `feat: spec loading, deref, summary, slice`.

### Task 2: Mock transport from spec schemas

**Files:**
- Create: `src/sandbox/people.js`, `src/sandbox/mockServer.js`, `test/mock.test.js`

**Interfaces:**
- Consumes: `deref`.
- Produces: `createMockTransport(spec, { now: Date, seed?: number }) -> async (req: { method, url }) -> { status, json }`.
  - It matches the path against spec templates (`{uuid}` matches any segment).
  - It synthesises the 200 response schema and emulates cursor pagination when the response has an array property next to an object with a `next_page_token` / `next_cursor` / `next_page` field.
  - Collection sizes: 48 for paths containing `member`/`user`, 120 otherwise.
  - Page size comes from the `count` / `limit` / `per_page` query parameters (default 20).
  - It returns 404 for unknown paths.
  - The token is opaque (`"p<N>"`), and `next_page` is a full URL.

- [ ] **Step 1: Write failing tests:**
  - Paging `GET /organization_memberships?count=100` gives exactly 48 items across pages, with unique `user.email`.
  - Every `GET /scheduled_events` `event_memberships[].user_email` is in the first 37 people.
  - `start_time` values fall within `now − 90 days … now`.
  - An unknown path gives 404.
  - Review focus 1: a spec whose response has no schema returns `{status:200, json:{}}`.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement deterministic synthesis by format and name. OpenAPI 3.1 types like `type: [string, 'null']` use the first non-null type. Nested arrays get 1 item. The rules:
  - `email` → person email
  - `name` → person name
  - `date-time` → `now − ((i*17+j*5) % 85)` days
  - `uri` → `https://api.example/<path>/<id>`
  - an `enum` → first value
  - `integer` → `i+1`
  - `boolean` → `true`

  Person choice: for top-level collection items, person = `i % 48`. For arrays nested in an item, person = `(i*7+j) % 37`.
- [ ] **Step 4:** Run and expect PASS. Commit `feat: schema-driven mock transport`.

### Task 3: Connector SDK runtime, static checks, transpile

**Files:**
- Create: `src/sandbox/sdk.js`, `src/sandbox/staticChecks.js`, `src/sandbox/transpile.js`, `test/sdk.test.js`, `test/static.test.js`

**Interfaces:**
- Produces:
  - `createSdk({ baseUrl, allowedHost, transport, log, limits }) -> { defineConnector, http, paginate, log }`
    - `http.get` builds `new URL(path, baseUrl)`. It throws `SandboxViolation("Blocked: <host> is not <allowedHost>")` for another host.
    - `http.post`/`put`/`patch`/`delete` all throw `SandboxViolation("Blocked: write request (<METHOD>)")`.
    - Non-2xx responses throw `ApiError(status, body)`.
    - `paginate` throws `SandboxLimit("Stopped after 50 pages of <path>")`.
    - Each request appends `{ t, method, path, status, ms, records }` to the log.
  - `staticCheck(code: string, { allowedHost }) -> { ok: boolean, issues: [{ rule, line, message }] }`. Rules:
    - `network-global`: `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`, `navigator.sendBeacon`
    - `escape`: `globalThis`, `self.`, `window.`, `eval(`, `Function(`, `.constructor`, `process.`, `require(`
    - `dynamic-import`: `import(`
    - `foreign-import`: any import specifier other than `@cloudeagle/connector-sdk`
    - `write-call`: `http.(post|put|patch|delete)`
    - `foreign-host`: a URL literal whose host is not `allowedHost`
    - `secret-access`: `apiKey`, `token =`, `Authorization`
  - `transpile(ts: string) -> string`: sucrase with `transforms: ["typescript","imports"]`.

- [ ] **Step 1: Write failing tests.** SDK:
  - A GET to another host is blocked.
  - `http.post` is blocked.
  - Review focus 2: a pager whose `next` always returns `"x"` stops at 50 pages with `SandboxLimit`.

  Static checks: one case per rule, including `({}).constructor.constructor` and `import("x")`. The clean reference connector `fixtures/calendly.connector.ts` (write it in this step from the contract) has `ok === true`.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement. Static checks scan code with comments and strings stripped, except `foreign-host`, which scans string literals.
- [ ] **Step 4:** Run and expect PASS. Commit `feat: connector SDK, static checks, transpile`.

### Task 4: Execution core, Node runner, Worker runner, validation

**Files:**
- Create: `src/sandbox/execute.js`, `src/sandbox/runNode.js`, `src/sandbox/worker.js`, `src/sandbox/runBrowser.js`, `src/sandbox/validate.js`, `test/execute.test.js`

**Interfaces:**
- Consumes: `createSdk`, `transpile`, `createMockTransport`.
- Produces:
  - `executeConnector(js, { compile: (js) => (require, exports, module) => void, sdkOptions, now, timeoutMs=15000 }) -> Promise<{ users: object[], usage: object[], log: object[], error: null | { kind, message } }>`. Kinds: `compile`, `runtime`, `violation`, `limit`, `timeout`, `api`.
  - `runInNode(tsCode, { spec, plan, now }) -> same`: uses `vm.runInNewContext` with no globals beyond the wrapper args.
  - `runInBrowser(tsCode, { spec, plan, now }) -> same`: posts to `src/sandbox/worker.js`. The worker deletes `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts` and `indexedDB` before compiling with `new Function`, and proxies transport calls to the main thread over `postMessage`. A timeout calls `worker.terminate()`.
  - `validateRecords({ users, usage }, { now }) -> { ok, errors: string[], stats: { users, withActivity, inactive90d, unknownUsageEmails }, rows: [{ email, name, role, lastActive|null }] }`. Errors:
    - `"No users found"`
    - `"<n> users missing a valid email"`
    - `"Usage dates not ISO 8601"`
    - `"Usage refers to <n> emails that are not users"`, which is a warning when ≤ 10%

- [ ] **Step 1: Write failing tests.**
  - `runInNode(fixtures/calendly.connector.ts)` against the Calendly mock gives `stats.users === 48`, `stats.inactive90d === 11`, and `error === null`.
  - A connector that throws gives `error.kind === "runtime"`.
  - A connector calling `http.post` gives `"violation"`.
  - A never-ending pager gives `"limit"`.
  - `validateRecords({users:[],usage:[]})` errors include `"No users found"`.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and expect PASS. Commit `feat: sandbox execution and validation`.

### Task 5: AI client with live and replay modes, plus prompts

**Files:**
- Create: `src/ai/prompts.js`, `src/ai/client.js`, `test/ai.test.js`

**Interfaces:**
- Produces:
  - `PLAN_SCHEMA`: a JSON schema with `additionalProperties:false` throughout. Fields:
    - `appName`, `baseUrl`
    - `auth{type,scopes[],notes}`
    - `endpoints[{purpose:"setup"|"users"|"usage",method,path,why}]`
    - `pagination{style,tokenParam,nextField}`
    - `fieldMapping[{target:"User.email"|"User.name"|"User.role"|"User.externalId"|"UsageEvent.email"|"UsageEvent.at",source,endpoint,confidence:"high"|"medium"|"low",note}]`
    - `limitations[string]`
  - `triagePrompt(summary, wants: string[]) -> { system, user }`
  - `generatePrompt(plan, slicedSpec) -> { system, user }`: the system prompt carries the connector contract and the rules (read-only, SDK only, cite every endpoint and field with `// source:`, output one ```ts block).
  - `repairPrompt(code, failure: { stage, message, details }) -> { system, user }`
  - `extractCode(text) -> string`: throws `GenerationError("No code block in the model's reply")`.
  - `createAiClient({ mode: "live", apiKey, Anthropic } | { mode: "replay", recording, speed=1 }) -> { triage(prompt) -> Promise<{ plan, usage, ms }>, generate(prompt) -> Promise<{ text, usage, ms }>, recorder: { calls: [] } }`.
    - Live mode builds `new Anthropic({ apiKey, dangerouslyAllowBrowser: true })`.
      - `triage` uses `client.messages.create({ model:"claude-haiku-5-5", max_tokens:8000, output_config:{ effort:"low", format:{ type:"json_schema", schema: PLAN_SCHEMA } }, system, messages })`.
      - `generate` uses `client.beta.messages.create({ model:"claude-sonnet-5-5", max_tokens:16000, betas:["server-side-fallback-2026-07-01"], fallbacks:"default", output_config:{ effort:"medium" }, system, messages })` and joins the `text` blocks.
      - Both throw `AiRefusalError` on `stop_reason === "refusal"`.
      - Every call is pushed to `recorder.calls` as `{ step, response, usage, ms }`.
    - Replay serves `recording.calls` in order, waits `ms / speed`, and throws `ReplayExhausted` past the end.

- [ ] **Step 1: Write failing tests** with a fake `Anthropic` class:
  - Live `triage` sends the model `claude-haiku-5-5` and the `json_schema` format.
  - `generate` sends `fallbacks: "default"`.
  - A refusal throws `AiRefusalError`.
  - Replay returns the recorded responses in order.
  - Review focus 3: `extractCode("sorry")` throws `GenerationError`.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and expect PASS. Commit `feat: Claude client (live/replay) and prompts`.

### Task 6: Pipeline orchestration with the repair loop

**Files:**
- Create: `src/pipeline.js`, `test/pipeline.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `runPipeline({ specUrl | spec, wants, ai, runner: runInNode|runInBrowser, now, fetchImpl }, onEvent: (e) => void) -> Promise<Result>`.
  - Events: `{ type: "stage", stage: "read"|"plan"|"generate"|"static"|"mock"|"validate"|"repair"|"done"|"failed", status: "start"|"pass"|"fail", detail }` and `{ type: "attempt", n, code }`.
  - `Result = { plan, code, attempts: number, ladder: [{ stage, status, detail }], run, validation, usage: { inputTokens, outputTokens } }`.
  - The loop is: generate → static → transpile and run → validate. Any failure produces a `repairPrompt` and repeats, at most 3 repairs. After that the result has `status: "failed"` and keeps the last error.

- [ ] **Step 1: Write failing tests** with a scripted fake AI (`triage` returns a fixed Calendly plan):
  - (a) The first generation uses `http.post`, then the repair returns the reference connector: `attempts === 2`, the ladder has `static: fail`, then everything passes, and `validation.stats.users === 48`.
  - (b) Review focus 3: four replies with no code block end with `status: "failed"` and 4 generation attempts, and nothing throws.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and expect PASS. Commit `feat: pipeline with repair loop`.

### Task 7: Record the real Calendly run

**Files:**
- Create: `scripts/record.mjs`, `recordings/calendly.json`

**Interfaces:**
- Consumes: `runPipeline`, `createAiClient` (live, Node `Anthropic` from the npm SDK), `runInNode`.
- Produces: `recordings/calendly.json` = `{ recordedAt, specUrl, models, calls, result: { attempts, usage } }`.

- [ ] **Step 1:** Implement the script. It reads `ANTHROPIC_API_KEY` from the environment only and exits with a message if it is unset. The spec URL is `https://developer.calendly.com/openapi/calendly-api.yaml`, the wants are `["users","usage"]`, and `now` is the real clock.
- [ ] **Step 2:** Run `ANTHROPIC_API_KEY=… node scripts/record.mjs`. Expected: it prints the ladder and `users: 48`, and writes the file. Manan runs this with his key; the key never enters any file.
- [ ] **Step 3:** Check with `grep -r "sk-ant" .` excluding node_modules, which must print nothing. Commit `feat: recorded Calendly run`.

### Task 8: UI and Pages deploy

**Files:**
- Create: `index.html`, `assets/styles.css` (copied from `../figma-screens/styles.css` plus app rules), `src/ui/app.js`, `src/ui/render.js`, `README.md`, `.nojekyll`

**Interfaces:**
- Consumes: `runPipeline`, `createAiClient`, `runInBrowser`, `recordings/calendly.json` (via `fetch`).

- [ ] **Step 1:** Build `index.html` with an import map (`@anthropic-ai/sdk`, `js-yaml`, `sucrase` → jsdelivr `+esm`, pinned versions) and the screen layout:
  - top bar mode toggle "Recorded run / Live with your key"
  - key field in live mode only, stored in `sessionStorage`
  - docs URL field pre-filled with the Calendly spec URL
  - stepper
  - plan table with confidence and citation chips
  - ladder (5 rungs; shadow sync and live greyed out as "next in production")
  - tabs: Data preview / Code (citations in the gutter, parsed from `// source:`) / Run log
  - attempts and token usage
  - prototype disclaimer
- [ ] **Step 2: Verify.** Serve with `npx http-server -p 8080 .`, open in headless Chrome, and run replay mode end to end. Expected screenshot: plan table populated, ladder rungs 1 to 3 passed, preview showing 48 people and 11 inactive. Review focus 4: entering `https://example.com` in live mode shows the spec-error message.
- [ ] **Step 3:** README covering what it is, how to run it locally, how to record, the security notes, and links to the PRD and screens. Commit `feat: UI and docs`.
- [ ] **Step 4:** Ask Manan before running `gh repo create mbhandari31/cloudeagle-integration-builder --public --source . --push` and enabling Pages from `main` root (`gh api repos/:owner/:repo/pages -X POST -f source[branch]=main -f source[path]=/`). Then verify the Pages URL loads and replay completes.
