# AI Integration Builder: prototype

This is a working prototype of the AI Integration Builder described in the PRD for the CloudEagle Senior PM assignment ([PRD](https://claude.ai/artifact/VsLrz7UWDwvUViNByq2cF1)). You point it at an API's OpenAPI docs. Claude drafts a plan and writes a TypeScript connector, and a sandbox checks the connector before any data is shown.

It is a static page with no server and no build step. By default it plays back a recorded real run against Calendly's API, so you don't need a key. In Live mode you paste your own Anthropic key and can try any OpenAPI URL. The sandbox always runs on synthetic data generated from the spec; no real customer data is used.

## How it works

The pipeline is in `src/pipeline.js`. It runs the same way in Node and in the browser.

- **Read:** fetch the OpenAPI spec (JSON or YAML) and summarise it in code (`src/spec/`).
- **Plan:** Claude Haiku picks the smallest set of GET endpoints for users and usage, the scopes, pagination, and a field mapping with a confidence level for each field (structured JSON output).
- **Slice:** the spec is cut down to the planned endpoints, with `$ref`s resolved.
- **Generate:** Claude Sonnet writes the connector against a small SDK, `@cloudeagle/connector-sdk`, and cites the spec with a trailing `// source:` comment on each line that calls an endpoint.
- **Code checks:** a static scan rejects network globals, sandbox escapes, dynamic imports, write calls, credential access and other hosts.
- **Practice run:** the connector is transpiled and run against a mock server built from the spec's response schemas (48 fictional people, 37 with recent activity, cursor pagination).
- **Schema check:** the output is checked for valid emails, ISO 8601 dates and activity that belongs to known users.
- **Repair:** any failure goes back to Sonnet with the error, up to 3 times.

The page shows each step as it happens: the plan with citations, the safety ladder, the attempt history, the data preview, the code with citations in the gutter, and the sandbox's request log.

## Safety model

What is enforced, and where:

- **Static checks** (`src/sandbox/staticChecks.js`) run on the main thread before any code executes. They are an early warning that gives the repair loop a precise error; they are pattern-based and can be beaten (string concatenation, comments in odd places), so they are not the boundary.
- **The SDK** (`src/sandbox/sdk.js`) only allows GET requests to the planned vendor host, and caps pages and records.
- **In the browser**, the connector runs in a module Web Worker (`src/sandbox/worker.js`):
  - The worker is started from a `blob:` URL (a one-line module that imports `worker.js`), so it inherits the page's Content Security Policy. A same-origin worker URL would not: GitHub Pages sends no CSP header, and a `<meta>` CSP covers only the page.
  - Under that policy, script loading is limited to this site and `blob:` (`script-src 'self' blob:`), with no `'unsafe-eval'`. So `import("https://elsewhere…")`, `eval`, `new Function` and string timers are refused by the browser inside the worker.
  - `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`, `WebTransport`, `BroadcastChannel`, nested workers, `caches`, `indexedDB` and `postMessage` are deleted before connector code is loaded. `connect-src` allows any `https:` origin (Live mode reads the spec URL you paste), so the worker relies on these deletions, not on the CSP, for fetch-style requests.
  - The connector is compiled without eval: its transpiled code is wrapped in a function and loaded as a `blob:` module. `blob:` modules run under the same policy.
  - Dynamic code paths are also neutralised in the worker, as defence in depth: `eval` and `Function` are removed, `.constructor` on the function, async function, generator and async generator prototypes throws `Blocked: dynamic code`, `setTimeout`/`setInterval` reject strings, and `URL.createObjectURL` is removed so connector code can't mint its own modules.
  - The worker accepts exactly one run message, so connector code can't start another run or hijack the listener. Sucrase also rewrites any `import()` in connector code into a call to the SDK's `require`, which rejects anything but `@cloudeagle/connector-sdk`.
- **The main thread re-checks every request** the worker sends (GET only, https only, the planned host only) and answers it from the mock server. Nothing reaches the real vendor API.
- **The page itself** loads scripts only from this site: the three libraries are vendored as single files in `vendor/` (no CDN).
- **The model never sees a key**, and the page sends your key only to `api.anthropic.com`. It is kept in `sessionStorage` for this tab only.

`npm run check:browser` checks the browser boundary in headless Chrome (set `CHROME_PATH` if Chrome isn't in `/Applications`). It runs connectors that try known escapes (the function-constructor family reached through string concatenation, a comment-hidden `import()`, a string timer, `eval`, a self-made `blob:` module) straight through `runInBrowser`, skipping the static scan, and asserts that an "attacker" server on another port gets no requests. It also probes the worker's inherited policy directly and checks that the golden Calendly connector still passes.

This is a prototype boundary, checked against the escapes we know of, not a proven one. `runInNode` (`src/sandbox/runNode.js`) uses Node's `vm` module and is a trusted-developer runner for tests and recording only; `vm` is not a security boundary. A production runtime would run each connector in a network-isolated container, with an egress proxy that holds the credentials.

## Run locally

```sh
npm install && npm test
npx http-server -p 8080 .
```

Then open http://localhost:8080. Any static server works; the page must be served over http, not opened as a file. The layout targets desktop widths of 1280 px and up.

### Vendored libraries

The page has no build step, but it doesn't load code from a CDN either. `@anthropic-ai/sdk` 1.4.0, `js-yaml` 4.1.0 and `sucrase` 3.35.0 are committed as single-file ESM bundles in `vendor/`, and the import map in `index.html` points at them. To rebuild them from `node_modules` (after changing a pinned version), run `npm run vendor` (`scripts/vendor.sh`, esbuild 0.24.0). If you change the import map, recompute its `sha256-` hash in the page's CSP.

## Record a run

The recorded run in `recordings/calendly.json` is made once with a real key:

```sh
export ANTHROPIC_API_KEY=…
npm run record
```

The script reads the key from the environment only, runs the full pipeline against the committed snapshot of Calendly's spec (`fixtures/calendly-api.yaml`), and refuses to write the file if it contains anything that looks like a key. The recording keeps each request's model, system prompt and messages, and each full response.

The recording stores the official spec URL (shown in the page), `specSource` and a `specSha256` of the snapshot. Replay always reads the same snapshot, never the live spec, so a change to Calendly's published spec can't break the recorded demo; if the snapshot's hash doesn't match the recording, the run log shows a warning. Refresh the snapshot and re-record together.

If the file is missing, the page says so and points you to Live mode.

## Models and why

- **`claude-haiku-5-5` for triage** (effort `low`, structured JSON output): planning is a read-and-choose task over a compact summary, so the fast, cheap model is enough, and the JSON schema keeps the plan machine-checkable.
- **`claude-sonnet-5-5` for generation and repair** (effort `medium`): writing code that passes the checks needs the stronger model. Requests use server-side fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) so a capacity problem doesn't fail the run.
- Refusals are shown as a failed step, not retried.

## Limitations

- The sandbox only ever sees synthetic data. There is no OAuth flow, no real vendor call, no shadow sync and no scheduling; the ladder shows the last two rungs as "Next, in production".
- Live mode needs the spec URL to allow cross-origin requests (Calendly's does). Many docs sites don't, and then the page reports that it couldn't read the spec.
- Mock data comes from the spec's schemas, so a connector can pass here and still meet surprises in a real API (undocumented fields, rate limits, odd pagination).
- The static scan is pattern-based and deliberately strict; it can reject harmless code, which the repair loop then rewrites.
- Calling the Anthropic API from the browser exposes your key to this page's JavaScript. Use a key you can revoke.

## Related

- PRD: https://claude.ai/artifact/VsLrz7UWDwvUViNByq2cF1
- Design screens are part of the assignment submission. This page reuses their stylesheet as `assets/styles.css`.
