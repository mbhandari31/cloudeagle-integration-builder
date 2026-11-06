import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSpec } from "../src/spec/load.js";
import { createMockTransport } from "../src/sandbox/mockServer.js";
import { runInNode } from "../src/sandbox/runNode.js";
import { executeConnector } from "../src/sandbox/execute.js";
import { validateRecords } from "../src/sandbox/validate.js";

const spec = parseSpec(readFileSync(new URL("../fixtures/calendly-api.yaml", import.meta.url), "utf8"));
const golden = readFileSync(new URL("../fixtures/calendly.connector.ts", import.meta.url), "utf8");
const now = new Date("2026-11-06T00:00:00Z");
const plan = { baseUrl: "https://api.calendly.com" };

// Counts transport calls so tests can prove nothing left the sandbox.
const run = async (ts, extra = {}) => {
  const calls = [];
  const inner = createMockTransport(spec, { now });
  const transport = async (req) => { calls.push(req); return inner(req); };
  const result = await runInNode(ts, { spec, plan, now, transport, ...extra });
  return { result, calls };
};

const connector = (users, usage = "async *usage() {}") => `
import { defineConnector, http, paginate, log } from "@cloudeagle/connector-sdk";
export default defineConnector({
  app: "t",
  baseUrl: "https://api.calendly.com",
  ${users},
  ${usage},
});
`;

test("golden Calendly connector runs and validates", async () => {
  const { result } = await run(golden);
  assert.equal(result.error, null);
  assert.equal(result.users.length, 48);
  assert.ok(result.usage.length > 0);
  assert.ok(result.log.some((e) => e.level === "info" && /^organization /.test(e.message)));
  assert.ok(result.log.some((e) => e.method === "GET" && e.path === "/scheduled_events"));
  const v = validateRecords(result, { now });
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
  assert.equal(v.stats.users, 48);
  assert.equal(v.stats.inactive90d, 11);
  assert.equal(v.stats.withActivity, 37);
  assert.equal(v.stats.unknownUsageEmails, 0);
  assert.equal(v.rows.length, 48);
  const names = v.rows.map((r) => r.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test("ctx.since is now minus 90 days", async () => {
  const { result } = await run(connector(`async *users(ctx) { yield { email: "a@b.co", name: ctx.since, role: "x" }; }`));
  assert.equal(result.error, null);
  assert.equal(result.users[0].name, "2026-08-08T00:00:00.000Z");
});

test("a connector that throws gives a runtime error", async () => {
  const { result } = await run(connector(`async *users() { throw new Error("boom"); }`));
  assert.deepEqual(result.error, { kind: "runtime", message: "boom" });
});

test("http.post gives a violation", async () => {
  const { result, calls } = await run(connector(`async *users() { await http.post("/users"); }`));
  assert.equal(result.error.kind, "violation");
  assert.equal(result.error.message, "Blocked: write request (POST)");
  assert.equal(calls.length, 0);
});

test("a never-ending pager gives a limit error", async () => {
  const { result } = await run(connector(`async *users() {
    yield* paginate("/organization_memberships", { next: () => "again", items: (r) => r.collection });
  }`));
  assert.equal(result.error.kind, "limit");
  assert.match(result.error.message, /Stopped after 50 pages/);
});

test("non-2xx response gives an api error", async () => {
  const { result } = await run(connector(`async *users() { await http.get("/nope"); }`));
  assert.equal(result.error.kind, "api");
});

test("TypeScript that does not transpile gives a compile error", async () => {
  const { result } = await run("export default {{{ ;");
  assert.equal(result.error.kind, "compile");
});

test("a connector that never finishes is stopped by the timeout", async () => {
  const { result } = await run(connector(`async *users() { await new Promise(() => {}); }`), { timeoutMs: 50 });
  assert.deepEqual(result.error, { kind: "timeout", message: "Stopped after 0.05 s" });
});

test("timeout message uses whole seconds", async () => {
  const neverEnds = () => () => {};
  const r = await executeConnector("", {
    compile: () => (req, exp) => { exp.default = { users: async function* () { await new Promise(() => {}); }, usage: async function* () {} }; },
    sdkOptions: { baseUrl: plan.baseUrl, allowedHost: "api.calendly.com", transport: neverEnds },
    now, timeoutMs: 1000,
  });
  assert.deepEqual(r.error, { kind: "timeout", message: "Stopped after 1 s" });
});

test("records collected before an error are returned", async () => {
  const { result } = await run(connector(`async *users() { yield { email: "a@b.co" }; throw new Error("late"); }`));
  assert.equal(result.users.length, 1);
  assert.equal(result.error.kind, "runtime");
});

// Runtime boundary: static checks can be fooled, the vm context is the real wall.
test("runtime: fetch is not available inside the sandbox", async () => {
  const { result, calls } = await run(connector(`async *users() { await globalThis.fetch("https://evil.example"); }`));
  assert.equal(result.error.kind, "runtime");
  assert.equal(calls.length, 0);
});

test("runtime: no host globals reachable through the Function constructor", async () => {
  const { result } = await run(connector(`async *users() {
    const F = ({}).constructor.constructor;
    yield { email: "a@b.co", name: F("return typeof process")(), role: F("return typeof require + typeof setTimeout + typeof fetch")() };
    yield { email: "c@d.co", name: typeof globalThis.process, role: Object.keys(globalThis).join(",") };
    process.exit(1);
  }`));
  assert.deepEqual(result.users.map((u) => [u.name, u.role]), [
    ["undefined", "undefinedundefinedundefined"],
    ["undefined", ""],
  ]);
  assert.equal(result.error.kind, "runtime");
  assert.match(result.error.message, /process is not defined/);
});

test("runtime: requiring anything but the SDK is a violation", async () => {
  const { result } = await run(`const fs = require("node:fs");\nexport default fs;`);
  assert.deepEqual(result.error, { kind: "violation", message: "Blocked: import of node:fs" });
});

test("validate: no users", () => {
  const v = validateRecords({ users: [], usage: [] }, { now });
  assert.equal(v.ok, false);
  assert.ok(v.errors.includes("No users found"));
});

test("validate: missing emails and non-ISO dates", () => {
  const v = validateRecords({
    users: [{ email: "a@b.co", name: "A" }, { email: "nope", name: "B" }, { name: "C" }],
    usage: [{ email: "a@b.co", at: "yesterday" }],
  }, { now });
  assert.equal(v.ok, false);
  assert.ok(v.errors.includes("2 users missing a valid email"));
  assert.ok(v.errors.includes("Usage dates not ISO 8601"));
});

test("validate: lastActive is the max usage date, matched case-insensitively", () => {
  const v = validateRecords({
    users: [
      { email: "Zed@x.co", name: "Zed", role: "user" },
      { email: "amy@x.co", name: "Amy", role: "admin" },
      { email: "old@x.co", name: "Old", role: "user" },
    ],
    usage: [
      { email: "zed@X.co", at: "2026-10-01T00:00:00Z" },
      { email: "ZED@x.co", at: "2026-11-01T00:00:00.000Z" },
      { email: "old@x.co", at: "2026-01-01T00:00:00Z" },
    ],
  }, { now });
  assert.equal(v.ok, true);
  assert.deepEqual(v.rows, [
    { email: "amy@x.co", name: "Amy", role: "admin", lastActive: null },
    { email: "old@x.co", name: "Old", role: "user", lastActive: "2026-01-01T00:00:00.000Z" },
    { email: "Zed@x.co", name: "Zed", role: "user", lastActive: "2026-11-01T00:00:00.000Z" },
  ]);
  assert.deepEqual(v.stats, { users: 3, withActivity: 2, inactive90d: 2, unknownUsageEmails: 0 });
});

test("validate: unknown usage emails are a warning up to 10%, an error above", () => {
  const users = Array.from({ length: 10 }, (_, i) => ({ email: `u${i}@x.co`, name: `U${i}` }));
  const at = "2026-11-01T00:00:00Z";
  const known = users.map((u) => ({ email: u.email, at }));
  const one = validateRecords({ users, usage: [...known, { email: "ghost@x.co", at }] }, { now });
  assert.equal(one.ok, true);
  assert.deepEqual(one.errors, []);
  assert.deepEqual(one.warnings, ["Usage refers to 1 emails that are not users"]);
  assert.equal(one.stats.unknownUsageEmails, 1);
  const two = validateRecords({ users, usage: [...known, { email: "g1@x.co", at }, { email: "g2@x.co", at }] }, { now });
  assert.equal(two.ok, false);
  assert.ok(two.errors.includes("Usage refers to 2 emails that are not users"));
});
