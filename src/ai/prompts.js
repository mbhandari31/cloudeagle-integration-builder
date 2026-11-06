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
- Describe pagination (style, the query parameter that carries the next token, and the response field holding it); use empty strings if there is none.
- Map each target field to a response field path and the endpoint it comes from, with an honest confidence.
- Put anything the API cannot provide, or that you are unsure about, in limitations. Never invent endpoints or fields that are not in the summary.`;

export function triagePrompt(summary, wants) {
  return {
    system: TRIAGE_SYSTEM,
    user: `The connector must provide: ${wants.join(", ")}.

API summary (JSON):
${JSON.stringify(summary, null, 2)}`,
  };
}

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
- paginate(path, { query?, next: (res) => token | null, tokenParam?: "page_token", items: (res) => array, map?: (item) => record | record[] | null }) is an async generator: it requests path, yields items(res) (passed through map when given; an array result yields each element, null skips), then repeats with query[tokenParam] = next(res) until next returns null/undefined. Use \`yield* paginate(...)\`.
- log(message) writes a progress line.

Rules:
- Read-only: only call http.get and paginate. Never use fetch, XMLHttpRequest, import(), eval, globalThis, process or require, and import nothing except the SDK import shown above.
- Never touch credentials: no API keys, tokens or Authorization headers. CloudEagle injects auth.
- Cite your sources: add a trailing \`// source: <METHOD path or spec section>\` comment on every line that calls an endpoint or maps a field.
- Use only endpoints and fields that exist in the provided spec.
- Output exactly one \`\`\`ts code block containing the whole connector, and nothing after it.

Short example of the style (a fictional API):
\`\`\`ts
import { defineConnector, http, paginate, log } from "@cloudeagle/connector-sdk";

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
      next: (res: any) => res.next_cursor,
      tokenParam: "cursor",
      items: (res: any) => res.data,
      map: (e: any) => ({ email: e.user_email, at: e.created_at }), // source: Login.user_email, Login.created_at
    });
  },
});
\`\`\``;

export function generatePrompt(plan, slicedSpec) {
  return {
    system: GENERATE_SYSTEM,
    user: `Write the connector for this plan.

Plan (JSON):
${JSON.stringify(plan, null, 2)}

Relevant part of the OpenAPI spec (JSON, $refs resolved):
${JSON.stringify(slicedSpec, null, 2)}`,
  };
}

export function repairPrompt(code, failure) {
  const { stage, message, details } = failure;
  return {
    system: GENERATE_SYSTEM,
    user: `Your connector failed at the "${stage}" stage.

Error: ${message}
${details === undefined ? "" : `Details (JSON):\n${JSON.stringify(details, null, 2)}\n`}
Your previous code:
\`\`\`ts
${code}
\`\`\`

Fix the problem and output the complete corrected connector as exactly one \`\`\`ts code block.`,
  };
}

const FENCE_RE = /```(?:ts|typescript)[ \t]*\r?\n([\s\S]*?)^```/m;

export function extractCode(text) {
  const m = FENCE_RE.exec(text || "");
  if (!m) throw new GenerationError("No code block in the model's reply");
  return m[1];
}
