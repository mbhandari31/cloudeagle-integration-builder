import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_SCHEMA, triagePrompt, generatePrompt, repairPrompt, extractCode, GenerationError,
} from "../src/ai/prompts.js";
import { createAiClient, AiRefusalError, ReplayMismatch, ReplayExhausted } from "../src/ai/client.js";

const PLAN = {
  appName: "calendly", baseUrl: "https://api.calendly.com",
  auth: { type: "oauth2", scopes: ["users:read"], notes: "" },
  endpoints: [{ purpose: "users", method: "GET", path: "/organization_memberships", why: "members" }],
  pagination: { style: "cursor", tokenParam: "page_token", nextField: "pagination.next_page_token" },
  fieldMapping: [{ target: "User.email", source: "user.email", endpoint: "GET /organization_memberships", confidence: "high", note: "" }],
  limitations: [],
};
const usage = { input_tokens: 10, output_tokens: 20 };
const triageResponse = { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(PLAN) }], usage };
const codeText = "Here it is.\n```ts\nexport default 1;\n```";
const generateResponse = {
  stop_reason: "end_turn",
  content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Here it is.\n" }, { type: "text", text: "```ts\nexport default 1;\n```" }],
  usage,
};

function fakeAnthropic(responses) {
  const calls = [];
  class FakeAnthropic {
    constructor(opts) {
      calls.push({ ctor: opts });
      this.messages = { create: async (args) => { calls.push({ api: "messages", args }); return responses.shift(); } };
      this.beta = { messages: { create: async (args) => { calls.push({ api: "beta", args }); return responses.shift(); } } };
    }
  }
  return { FakeAnthropic, calls };
}

const prompt = { system: "SYS", user: "USER" };

test("live triage sends haiku with the json_schema format and parses the plan", async () => {
  const { FakeAnthropic, calls } = fakeAnthropic([triageResponse]);
  const ai = createAiClient({ mode: "live", apiKey: "k", Anthropic: FakeAnthropic });
  const out = await ai.triage(prompt);
  assert.deepEqual(calls[0].ctor, { apiKey: "k", dangerouslyAllowBrowser: true });
  const { args } = calls[1];
  assert.equal(calls[1].api, "messages");
  assert.equal(args.model, "claude-haiku-5-5");
  assert.equal(args.max_tokens, 8000);
  assert.deepEqual(args.output_config, { effort: "low", format: { type: "json_schema", schema: PLAN_SCHEMA } });
  assert.equal(args.system, "SYS");
  assert.deepEqual(args.messages, [{ role: "user", content: "USER" }]);
  assert.ok(!("temperature" in args) && !("thinking" in args));
  assert.deepEqual(out.plan, PLAN);
  assert.deepEqual(out.usage, usage);
  assert.equal(typeof out.ms, "number");
  assert.equal(ai.recorder.calls.length, 1);
  assert.equal(ai.recorder.calls[0].step, "triage");
  assert.deepEqual(ai.recorder.calls[0].request, { model: "claude-haiku-5-5", system: "SYS", messages: args.messages });
  assert.equal(ai.recorder.calls[0].response, triageResponse);
});

test("live generate sends sonnet with fallbacks and joins only text blocks", async () => {
  const { FakeAnthropic, calls } = fakeAnthropic([generateResponse, generateResponse]);
  const ai = createAiClient({ mode: "live", apiKey: "k", Anthropic: FakeAnthropic });
  const out = await ai.generate(prompt);
  const { args } = calls[1];
  assert.equal(calls[1].api, "beta");
  assert.equal(args.model, "claude-sonnet-5-5");
  assert.equal(args.max_tokens, 16000);
  assert.deepEqual(args.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(args.fallbacks, "default");
  assert.deepEqual(args.output_config, { effort: "medium" });
  assert.equal(out.text, codeText);
  await ai.repair(prompt);
  assert.deepEqual(ai.recorder.calls.map((c) => c.step), ["generate", "repair"]);
});

test("a refusal throws AiRefusalError with the category", async () => {
  const refusal = { stop_reason: "refusal", stop_details: { category: "cyber" }, content: [], usage };
  const { FakeAnthropic } = fakeAnthropic([refusal, { ...refusal }]);
  const ai = createAiClient({ mode: "live", apiKey: "k", Anthropic: FakeAnthropic });
  await assert.rejects(ai.triage(prompt), (e) => e instanceof AiRefusalError && /cyber/.test(e.message));
  await assert.rejects(ai.generate(prompt), AiRefusalError);
});

test("max_tokens on generate still returns the text", async () => {
  const cut = { stop_reason: "max_tokens", content: [{ type: "text", text: "```ts\nexport def" }], usage };
  const { FakeAnthropic } = fakeAnthropic([cut]);
  const ai = createAiClient({ mode: "live", apiKey: "k", Anthropic: FakeAnthropic });
  const { text } = await ai.generate(prompt);
  assert.equal(text, "```ts\nexport def");
  assert.throws(() => extractCode(text), GenerationError);
});

test("replay returns the recorded responses in order through the live parsing path", async () => {
  const recording = { calls: [
    { step: "triage", request: {}, response: triageResponse, usage, ms: 1200 },
    { step: "generate", request: {}, response: generateResponse, usage, ms: 3000 },
    { step: "repair", request: {}, response: generateResponse, usage, ms: 50 },
  ] };
  const ai = createAiClient({ mode: "replay", recording, speed: Infinity });
  assert.deepEqual(await ai.triage(prompt), { plan: PLAN, usage, ms: 1200 });
  assert.deepEqual(await ai.generate(prompt), { text: codeText, usage, ms: 3000 });
  assert.deepEqual(await ai.repair(prompt), { text: codeText, usage, ms: 50 });
  await assert.rejects(ai.generate(prompt), ReplayExhausted);
});

test("replay waits ms / speed", async () => {
  const recording = { calls: [{ step: "triage", request: {}, response: triageResponse, usage, ms: 400 }] };
  const ai = createAiClient({ mode: "replay", recording, speed: 10 });
  const t0 = Date.now();
  await ai.triage(prompt);
  assert.ok(Date.now() - t0 >= 35);
});

test("replay throws ReplayMismatch when the step differs", async () => {
  const recording = { calls: [{ step: "triage", request: {}, response: triageResponse, usage, ms: 0 }] };
  const ai = createAiClient({ mode: "replay", recording, speed: Infinity });
  await assert.rejects(ai.generate(prompt), ReplayMismatch);
});

test("extractCode requires a closed ts fence", () => {
  assert.throws(() => extractCode("sorry"), (e) => e instanceof GenerationError && e.message === "No code block in the model's reply");
  assert.throws(() => extractCode("```ts\nconst a = 1;"), GenerationError);
  assert.equal(extractCode("intro\n```typescript\nconst a = 1;\n```\n"), "const a = 1;\n");
  assert.equal(extractCode(codeText), "export default 1;\n");
});

function eachObject(node, fn) {
  if (node && typeof node === "object") {
    if (node.type === "object") fn(node);
    for (const v of Object.values(node)) eachObject(v, fn);
  }
}

test("PLAN_SCHEMA is strict: every object closed and fully required", () => {
  let n = 0;
  eachObject(PLAN_SCHEMA, (o) => {
    n++;
    assert.equal(o.additionalProperties, false);
    assert.deepEqual([...o.required].sort(), Object.keys(o.properties).sort());
  });
  assert.ok(n >= 5);
  assert.deepEqual(PLAN_SCHEMA.properties.fieldMapping.items.properties.target.enum,
    ["User.email", "User.name", "User.role", "User.externalId", "UsageEvent.email", "UsageEvent.at"]);
  assert.deepEqual(PLAN_SCHEMA.properties.endpoints.items.properties.purpose.enum, ["setup", "users", "usage"]);
});

test("prompt builders carry the contract and inputs", () => {
  const t = triagePrompt({ title: "Calendly", endpoints: [{ method: "get", path: "/users/me" }] }, ["users", "usage"]);
  assert.match(t.user, /\/users\/me/);
  assert.match(t.user, /users, usage/);
  const g = generatePrompt(PLAN, { paths: { "/organization_memberships": {} } });
  for (const re of [/@cloudeagle\/connector-sdk/, /defineConnector/, /http\.get/, /paginate/, /\/\/ source:/, /read-only/i, /```ts/, /credentials/i, /ctx\.state/]) {
    assert.match(g.system, re);
  }
  assert.doesNotMatch(g.system, /calendly|organization_memberships/i);
  assert.match(g.user, /organization_memberships/);
  const r = repairPrompt("const x = 1;", { stage: "static", message: "Blocked: write request (POST)", details: { line: 3 } });
  assert.equal(r.system, g.system);
  assert.match(r.user, /const x = 1;/);
  assert.match(r.user, /static/);
  assert.match(r.user, /Blocked: write request/);
  assert.match(r.user, /"line": 3/);
});
