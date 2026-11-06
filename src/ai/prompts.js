// Prompt builders and the plan schema. No imports, no Node-only APIs: runs in Node and the browser.
export class GenerationError extends Error {
  constructor(message) { super(message); this.name = "GenerationError"; this.kind = "generation"; }
}

const obj = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const str = { type: "string" };
const strs = { type: "array", items: str };

export const PLAN_SCHEMA = obj({
  appName: str,
  baseUrl: str,
  auth: obj({ type: str, scopes: strs, notes: str }),
  endpoints: {
    type: "array",
    items: obj({ purpose: { type: "string", enum: ["setup", "users", "usage"] }, method: str, path: str, why: str }),
  },
  pagination: obj({ style: str, tokenParam: str, nextField: str }),
  fieldMapping: {
    type: "array",
    items: obj({
      target: {
        type: "string",
        enum: ["User.email", "User.name", "User.role", "User.externalId", "UsageEvent.email", "UsageEvent.at"],
      },
      source: str,
      endpoint: str,
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      note: str,
    }),
  },
  limitations: strs,
});

const TRIAGE_SYSTEM = `You plan read-only SaaS connectors for CloudEagle, a SaaS management platform.
Given a compact summary of an OpenAPI spec, choose the smallest set of GET endpoints that lets a connector:
- users: list every user/member of the customer's account (email required; name, role, external id if available);
- usage: list activity events per user (user email + ISO 8601 timestamp) for the last 90 days.
Rules:
- Only GET endpoints. Mark endpoints needed first (e.g. "who am I" / organization lookup) with purpose "setup".
- Pick the minimum OAuth scopes / auth needed for those endpoints; say how auth works in auth.notes.
- Describe pagination (style, the query parameter that carries the next page cursor, and the response field holding it); use empty strings if there is none.
- Map each target field to a source and the endpoint it comes from, with an honest confidence. fieldMapping.source is a JSON path relative to one item of that endpoint's list (or relative to the response root for an endpoint that does not return a list).
- If the API has no real login/activity data, you may use a proxy for usage only when it is the closest real per-user activity signal in the spec (e.g. events a user took part in). Record in limitations that it is a proxy, not login/activity data. Never invent an activity endpoint.
- Put anything the API cannot provide, or that you are unsure about, in limitations. Never invent endpoints or fields that are not in the summary.`;

export function triagePrompt(summary, wants) {
  return {
    system: TRIAGE_SYSTEM,
    user: `The connector must provide: ${wants.join(", ")}.

API summary (JSON):
${JSON.stringify(summary, null, 2)}`,
  };
}

// The generic style example embedded in the generate prompt (fictional API). It must pass
// staticCheck itself, so it never models wording the scanner rejects.
export const EXAMPLE_CONNECTOR = `import { defineConnector, http, paginate, log } from "@cloudeagle/connector-sdk";

export default defineConnector({
  app: "acme",
  baseUrl: "https://api.acme.example",
  auth: { type: "bearer", scopes: [] },

  async *users(ctx: any) {
    const acct = await http.get("/v1/account"); // source: GET /v1/account
    ctx.state.accountId = acct.id; // source: GET /v1/account -> id
    log(\`account \${ctx.state.accountId}\`);
    yield* paginate(\`/v1/accounts/\${ctx.state.accountId}/members\`, { // source: GET /v1/accounts/{id}/members
      next: (res: any) => res.next_cursor, // source: GET /v1/accounts/{id}/members -> next_cursor
      tokenParam: "cursor",
      items: (res: any) => res.data,
      map: (m: any) => ({
        email: m.email_address, // source: Member.email_address
        name: m.display_name, // source: Member.display_name
      }),
    });
  },

  async *usage(ctx: any) {
    yield* paginate("/v1/logins", { // source: GET /v1/logins
      query: { account: ctx.state.accountId, after: ctx.since },
      next: (res: any) => res.links.next, // source: GET /v1/logins -> links.next (absolute next-page URL)
      items: (res: any) => res.data,
      map: (e: any) => ({ email: e.user_email, at: e.created_at }), // source: Login.user_email, Login.created_at
    });
  },
});
`;

const GENERATE_SYSTEM = `You write read-only SaaS connectors for CloudEagle in TypeScript, against this SDK:

\`\`\`ts
import { defineConnector, http, paginate, log } from "@cloudeagle/connector-sdk";
export default defineConnector({
  app: string, baseUrl: string,
  auth: { type: "oauth2" | "bearer" | "api_key" | "basic", scopes: string[] },
  async *users(ctx) { /* yields { email, name?, role?, externalId? } */ },
  async *usage(ctx) { /* yields { email, at } where at is an ISO 8601 string */ },
});
\`\`\`

Runtime contract:
- ctx = { since, state }: since is an ISO 8601 string (now minus 90 days); state starts as {}. The same ctx object is passed to users and then to usage, so users may stash values (e.g. an account id) in ctx.state for usage.
- http.get(path, query?) returns Promise<json>. path is relative to baseUrl, or an absolute https URL on the same host. Non-2xx responses throw.
- paginate(path, { query?, next: (res) => cursor | null, tokenParam?: "page_token", items: (res) => array, map?: (item) => record | record[] | null }) is an async generator: it requests path, yields items(res) (passed through map when given; an array result yields each element, null skips), then repeats until next returns null/undefined. If next returns a cursor, the next request is path with query[tokenParam] = cursor. If next returns an absolute https URL on the same host (e.g. a next_page link), that URL is requested as-is. Use \`yield* paginate(...)\`.
- log(message) writes a progress line.

Rules:
- Read-only: only call http.get and paginate. Import nothing except the SDK import shown above.
- A scanner rejects these tokens anywhere in the file, including comments and strings: \`fetch(\`, \`window.\`, \`self.\`, \`globalThis\`, \`process.\`, \`require(\`, \`import(\`, \`eval(\`, \`Function(\`, \`.constructor\`, \`XMLHttpRequest\`, \`WebSocket\`, \`EventSource\`. Do not write them even in prose comments. The string literals "constructor" and "authorization" are also rejected.
- Never touch credentials: CloudEagle injects auth. Never name a variable \`token\`, \`apiKey\` or \`Authorization\`; call pagination values \`cursor\`.
- Do not put URLs on other hosts in strings; the only host allowed is the one in baseUrl.
- Cite your sources: add a trailing \`// source: <METHOD path or spec section>\` comment on every line that calls an endpoint or maps a field.
- Use only endpoints and fields that exist in the provided spec.
- Output exactly one \`\`\`ts code block containing the whole connector, and nothing after it.

Short example of the style (a fictional API):
\`\`\`ts
${EXAMPLE_CONNECTOR}\`\`\``;

const contextBlock = (plan, slicedSpec) => `Plan (JSON):
${JSON.stringify(plan ?? null, null, 2)}

Relevant part of the OpenAPI spec (JSON, $refs resolved):
${JSON.stringify(slicedSpec ?? null, null, 2)}`;

export function generatePrompt(plan, slicedSpec) {
  return {
    system: GENERATE_SYSTEM,
    user: `Write the connector for this plan.

${contextBlock(plan, slicedSpec)}`,
  };
}

export function repairPrompt(code, failure, { plan, slicedSpec } = {}) {
  const { stage, message, details } = failure;
  const previous = code
    ? `Your previous code:
\`\`\`ts
${code}
\`\`\``
    : "Your previous reply had no complete ```ts code block.";
  return {
    system: GENERATE_SYSTEM,
    user: `Your connector failed at the "${stage}" stage.

Error: ${message}
${details === undefined ? "" : `Details (JSON):\n${JSON.stringify(details, null, 2)}\n`}
${previous}

${contextBlock(plan, slicedSpec)}

Change only what the error requires; return the full corrected file as one \`\`\`ts block.`,
  };
}

const FENCE_RE = /```(?:ts|typescript)[ \t]*\r?\n([\s\S]*?)^```/gm;

// Takes the longest closed ```ts / ```typescript block (an unclosed, truncated block never matches).
export function extractCode(text) {
  let best = null;
  for (const m of String(text ?? "").matchAll(FENCE_RE)) if (best === null || m[1].length > best.length) best = m[1];
  if (best === null) throw new GenerationError("No code block in the model's reply");
  return best;
}
