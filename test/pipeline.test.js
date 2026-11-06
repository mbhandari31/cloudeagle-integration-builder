import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSpec } from "../src/spec/load.js";
import { runInNode } from "../src/sandbox/runNode.js";
import { PlanError, AiRefusalError } from "../src/ai/client.js";
import { runPipeline } from "../src/pipeline.js";

const spec = parseSpec(readFileSync(new URL("../fixtures/calendly-api.yaml", import.meta.url), "utf8"));
const golden = readFileSync(new URL("../fixtures/calendly.connector.ts", import.meta.url), "utf8");
const now = new Date("2026-11-06T00:00:00Z");

const PLAN = {
  appName: "calendly",
  baseUrl: "https://api.calendly.com",
  auth: { type: "oauth2", scopes: ["users:read", "scheduled_events:read"], notes: "OAuth bearer" },
  endpoints: [
    { purpose: "setup", method: "GET", path: "/users/me", why: "organization URI" },
    { purpose: "users", method: "GET", path: "/organization_memberships", why: "members" },
    { purpose: "usage", method: "GET", path: "/scheduled_events", why: "activity proxy" },
  ],
  pagination: { style: "cursor", tokenParam: "page_token", nextField: "pagination.next_page_token" },
  fieldMapping: [],
  limitations: ["Scheduled events are a proxy for activity"],
};
const usage = { input_tokens: 100, output_tokens: 50 };
const fenced = (code) => `Here is the connector.\n\`\`\`ts\n${code}\`\`\`\n`;

// Scripted fake AI: records each call; replies come from the given lists in order.
function fakeAi({ triage = () => ({ plan: PLAN }), generate = [], repair = [] } = {}) {
  const calls = [];
  const queue = { generate: [...generate], repair: [...repair] };
  const step = (name) => async (prompt) => {
    calls.push({ step: name, prompt });
    return { text: queue[name].shift(), usage, ms: 1 };
  };
  return {
    calls,
    triage: async (prompt) => { calls.push({ step: "triage", prompt }); return { ...(await triage()), usage, ms: 1 }; },
    generate: step("generate"),
    repair: step("repair"),
  };
}

const run = async (ai, runner = runInNode) => {
  const events = [];
  const result = await runPipeline({ spec, ai, runner, now }, (e) => events.push(e));
  return { result, events };
};

test("(a) a write call is caught by the static check and repaired", async () => {
  const lines = golden.split("\n");
  const i = lines.findIndex((l) => l.includes('http.get("/users/me")'));
  lines.splice(i + 1, 0, '    await http.post("/x");');
  const bad = lines.join("\n");
  const ai = fakeAi({ generate: [fenced(bad)], repair: [fenced(golden)] });

  const { result, events } = await run(ai);

  assert.equal(result.status, "passed");
  assert.equal(result.attempts, 2);
  assert.equal(result.code, golden);
  assert.equal(result.validation.stats.users, 48);
  assert.equal(result.validation.stats.inactive90d, 11);
  assert.equal(result.run.error, null);
  assert.deepEqual(result.usage, { inputTokens: 300, outputTokens: 150 });
  assert.deepEqual(
    result.ladder.map((r) => [r.stage, r.status]),
    [["read", "pass"], ["plan", "pass"], ["generate", "pass"], ["static", "pass"], ["mock", "pass"], ["validate", "pass"]],
  );

  // Events: static fails on attempt 1, then a repair and everything passes.
  const stages = events.filter((e) => e.type === "stage" && e.status !== "start").map((e) => `${e.stage}:${e.status}`);
  assert.deepEqual(stages, [
    "read:pass", "plan:pass", "generate:pass", "static:fail",
    "repair:pass", "static:pass", "mock:pass", "validate:pass", "done:pass",
  ]);
  const staticFail = events.find((e) => e.stage === "static" && e.status === "fail");
  assert.match(staticFail.detail, /^Attempt 1: static check found 1 issue \(write-call, line \d+\)$/);
  assert.equal(events.find((e) => e.stage === "read" && e.status === "pass").detail, "Found Calendly API: 65 endpoints");
  assert.equal(events.find((e) => e.stage === "plan" && e.status === "pass").detail, "Plan: 3 endpoints, pagination cursor");
  assert.equal(events.find((e) => e.stage === "validate" && e.status === "pass").detail, "48 people, 11 inactive for 90 days");
  assert.deepEqual(events.filter((e) => e.type === "attempt").map((e) => [e.n, e.code]), [[1, bad], [2, golden]]);

  // The repair prompt carries the previous code, the static issues and the plan context.
  assert.deepEqual(ai.calls.map((c) => c.step), ["triage", "generate", "repair"]);
  const repairUser = ai.calls[2].prompt.user;
  assert.match(repairUser, /failed at the "static" stage/);
  assert.match(repairUser, /write-call/);
  assert.ok(repairUser.includes('await http.post("/x");'));
  assert.ok(repairUser.includes("/scheduled_events"));
});

test("(b) four replies with no code block end failed after 4 attempts without throwing", async () => {
  const prose = "I would write a connector that lists members.";
  const ai = fakeAi({ generate: [prose], repair: [prose, prose, prose] });

  const { result, events } = await run(ai);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStage, "generate");
  assert.equal(result.attempts, 4);
  assert.equal(result.error.name, "GenerationError");
  assert.equal(result.code, null);
  assert.deepEqual(ai.calls.map((c) => c.step), ["triage", "generate", "repair", "repair", "repair"]);
  assert.match(ai.calls[2].prompt.user, /no complete ```ts code block/);
  assert.deepEqual(result.usage, { inputTokens: 500, outputTokens: 250 });
  assert.equal(result.ladder.find((r) => r.stage === "generate").status, "fail");
  assert.deepEqual(events.at(-1), { type: "stage", stage: "failed", status: "fail", detail: result.error.message });
});

test("(c) a plan error fails the run at the plan stage without throwing", async () => {
  const ai = fakeAi({ triage: () => { throw new PlanError("Couldn't read the plan from the model's reply"); } });

  const { result, events } = await run(ai);

  assert.equal(result.status, "failed");
  assert.equal(result.failedStage, "plan");
  assert.deepEqual(result.error, { name: "PlanError", message: "Couldn't read the plan from the model's reply" });
  assert.equal(result.attempts, 0);
  assert.deepEqual(ai.calls.map((c) => c.step), ["triage"]);
  assert.deepEqual(result.ladder.map((r) => [r.stage, r.status]), [["read", "pass"], ["plan", "fail"]]);
  assert.ok(events.some((e) => e.stage === "plan" && e.status === "fail"));
});

test("a plan without an https base URL fails at the plan stage", async () => {
  const ai = fakeAi({ triage: () => ({ plan: { ...PLAN, baseUrl: "http://api.calendly.com" } }) });
  const { result } = await run(ai);
  assert.equal(result.status, "failed");
  assert.equal(result.failedStage, "plan");
  assert.equal(result.error.message, "The plan has no valid https base URL");
});

test("a spec URL that is not OpenAPI fails at the read stage", async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => "<html>hi</html>" });
  const result = await runPipeline({ specUrl: "https://example.com", ai: fakeAi(), runner: runInNode, now, fetchImpl });
  assert.equal(result.status, "failed");
  assert.equal(result.failedStage, "read");
  assert.equal(result.error.name, "SpecError");
});

const outcomes = (events) => events.filter((e) => e.type === "stage" && e.status !== "start").map((e) => `${e.stage}:${e.status}`);
const allPass = [["read", "pass"], ["plan", "pass"], ["generate", "pass"], ["static", "pass"], ["mock", "pass"], ["validate", "pass"]];

test("a mock-run failure (404) is fed back and repaired", async () => {
  const bad = golden.replace('paginate("/scheduled_events"', 'paginate("/no_such_path"');
  assert.notEqual(bad, golden);
  const ai = fakeAi({ generate: [fenced(bad)], repair: [fenced(golden)] });
  const { result, events } = await run(ai);
  assert.equal(result.status, "passed");
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.ladder.map((r) => [r.stage, r.status]), allPass);
  assert.deepEqual(outcomes(events).slice(2, 5), ["generate:pass", "static:pass", "mock:fail"]);
  assert.match(events.find((e) => e.stage === "mock" && e.status === "fail").detail, /404/);
  const repairUser = ai.calls[2].prompt.user;
  assert.match(repairUser, /failed at the "mock" stage/);
  assert.match(repairUser, /"log"/);
});

test("a validation failure (users without email) is fed back and repaired", async () => {
  const bad = golden.replace("email: m.user.email,", "email: null,");
  assert.notEqual(bad, golden);
  const ai = fakeAi({ generate: [fenced(bad)], repair: [fenced(golden)] });
  const { result, events } = await run(ai);
  assert.equal(result.status, "passed");
  assert.equal(result.attempts, 2);
  assert.equal(result.validation.stats.users, 48);
  assert.ok(outcomes(events).includes("validate:fail"));
  assert.match(ai.calls[2].prompt.user, /failed at the "validate" stage[\s\S]*48 users missing a valid email/);
});

test("a runner that rejects counts as a mock failure and is repaired", async () => {
  let calls = 0;
  const flaky = async (code, opts) => {
    if (++calls === 1) throw new Error("Sandbox worker crashed");
    return runInNode(code, opts);
  };
  const ai = fakeAi({ generate: [fenced(golden)], repair: [fenced(golden)] });
  const { result, events } = await run(ai, flaky);
  assert.equal(result.status, "passed");
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
  assert.match(events.find((e) => e.stage === "mock" && e.status === "fail").detail, /Sandbox worker crashed/);
  assert.match(ai.calls[2].prompt.user, /failed at the "mock" stage[\s\S]*Sandbox worker crashed/);
});

test("a runner error result without log or records is handled", async () => {
  const runner = async () => ({ error: { kind: "runtime", message: "no log" } });
  const ai = fakeAi({ generate: [fenced(golden)], repair: [fenced(golden), fenced(golden), fenced(golden)] });
  const { result, events } = await run(ai, runner);
  assert.equal(result.status, "failed");
  assert.equal(result.failedStage, "mock");
  assert.equal(result.attempts, 4);
  assert.deepEqual(result.run, { users: [], usage: [], log: [], error: { kind: "runtime", message: "no log" } });
  assert.equal(events.at(-1).stage, "failed");
});

for (const [label, error] of [
  ["a refusal", new AiRefusalError("Claude declined the request")],
  ["a non-refusal error", new Error("socket hang up")],
]) {
  test(`${label} from ai.generate fails at the generate stage without throwing`, async () => {
    const ai = fakeAi();
    ai.generate = async () => { throw error; };
    const { result, events } = await run(ai);
    assert.equal(result.status, "failed");
    assert.equal(result.failedStage, "generate");
    assert.deepEqual(result.error, { name: error.name, message: error.message });
    assert.equal(result.attempts, 1);
    assert.equal(result.code, null);
    assert.deepEqual(result.ladder.at(-1), { stage: "generate", status: "fail", detail: error.message });
    assert.deepEqual(outcomes(events).slice(-2), ["generate:fail", "failed:fail"]);
  });
}

test("code from an earlier attempt is not kept when the last reply has no code", async () => {
  const prose = "Sorry, no code.";
  const bad = golden.replace('paginate("/scheduled_events"', 'paginate("/no_such_path"');
  const ai = fakeAi({ generate: [fenced(bad)], repair: [prose, prose, prose] });
  const { result } = await run(ai);
  assert.equal(result.status, "failed");
  assert.equal(result.failedStage, "generate");
  assert.equal(result.code, null);
  assert.equal(result.run, null);
});
