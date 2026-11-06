# AI Integration Builder prototype: design

Approved in conversation with Manan on 2026-11-06. It implements deliverable 3 of the CloudEagle Senior PM assignment and follows the PRD (https://claude.ai/artifact/VsLrz7UWDwvUViNByq2cF1).

## Intent

A reviewer at CloudEagle opens a public link, points the builder at Calendly's API docs, and watches a real pipeline:

1. read the docs,
2. draft a plan,
3. generate a connector,
4. pass the safety checks,
5. show the data.

The goal is to prove the PRD's bet works: AI writes the connector, and CloudEagle's runtime makes it safe.

## Decided

- **Hosting:** GitHub Pages, public repo `mbhandari31/cloudeagle-integration-builder`. This means a static site with no server and no build step. The browser loads dependencies from the jsdelivr CDN through an import map.
- **Two modes:**
  - **Replay (default):** a recorded real run, so no key is needed. Recorded once by Manan with his key through `scripts/record.mjs`. The key is never committed or shipped.
  - **Live:** the reviewer pastes their own Anthropic key. It is kept in `sessionStorage` only and used through the official SDK with `dangerouslyAllowBrowser: true`. Any OpenAPI URL works.
- **Models (from the PRD):**
  - `claude-haiku-5-5` for triage: effort `low`, structured JSON output.
  - `claude-sonnet-5-5` for generation and repair: effort `medium`, `fallbacks: "default"` with the beta `server-side-fallback-2026-07-01`.
  - Refusals are surfaced as an error step.
- **Pipeline:**
  1. Fetch the spec. Calendly allows CORS on its spec URL.
  2. Summarise the spec in code.
  3. Haiku triages it into a plan.
  4. Slice the spec down to the planned endpoints.
  5. Sonnet generates TypeScript against a mini SDK `@cloudeagle/connector-sdk`.
  6. Run the safety ladder:
     - static checks,
     - transpile,
     - mock run in the sandbox,
     - schema validation,
     - up to 3 repair rounds that feed errors back to Sonnet.
  7. Show the results.
- **Sandbox:**
  - In the browser, generated code runs in a Web Worker with network globals deleted. The only way out is the SDK, which allows GET to the planned vendor host only and is served by the mock transport.
  - In Node (tests and recording), the same core runs in `vm`.
- **Mock data:** synthesised from the spec's response schemas. It is deterministic and drawn from a pool of 48 people, 37 of whom have recent activity, with cursor pagination emulated.
- **UI:** a single page matching the approved screens, using the same styles. It shows a stepper, the plan table with citations, the ladder, the data preview, the code with citations, and a run log. It is labelled clearly as a prototype on mock data.

## Non-goals

OAuth, real Calendly data, shadow sync, production scheduling, persistence, and multi-app management. The ladder shows shadow sync and live as "next in production".

## Anti-goals

- A key in the repo or bundle.
- Generated code that can reach the network.
- A canned demo that can't run live.

## Left to the builder

Visual details within the existing style system, exact prompt wording, and mock data names.
