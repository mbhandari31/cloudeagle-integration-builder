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

- **Static checks** (`src/sandbox/staticChecks.js`) run on the main thread before any code executes.
- **The SDK** (`src/sandbox/sdk.js`) only allows GET requests to the planned vendor host, and caps pages and records.
- **In the browser**, the connector runs in a module Web Worker (`src/sandbox/worker.js`). The worker deletes `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `postMessage` and other network-capable globals before the connector is compiled. Every request the worker makes is passed to the main thread, which checks it again (GET, https, planned host only) and answers it from the mock server. Nothing reaches the real vendor API.
- **A Content Security Policy** in `index.html` limits scripts to this site and the jsdelivr CDN and workers to this site.
- **The model never sees a key**, and the page never sends your key anywhere but `api.anthropic.com`. It is kept in `sessionStorage` for the tab only.

The browser Worker, the main-thread request check and the CSP are this demo's boundary. `runInNode` (`src/sandbox/runNode.js`) uses Node's `vm` module and is a trusted-developer runner for tests and recording only; `vm` is not a security boundary. A production runtime would run each connector in a network-isolated container with an egress proxy that holds the credentials.

## Run locally

```sh
npm install && npm test
npx http-server -p 8080 .
```

Then open http://localhost:8080. Any static server works; the page must be served over http, not opened as a file.

## Record a run

The recorded run in `recordings/calendly.json` is made once with a real key:

```sh
export ANTHROPIC_API_KEY=…
npm run record
```

The script reads the key from the environment only, runs the full pipeline against Calendly's spec, and refuses to write the file if it contains anything that looks like a key. The recording keeps each request's model, system prompt and messages, and each full response.

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
- Approved screens: `figma-screens/` in the assignment folder (`01-start.html` to `06-live.html`, PNGs in `png/`). This page reuses their stylesheet as `assets/styles.css`.
