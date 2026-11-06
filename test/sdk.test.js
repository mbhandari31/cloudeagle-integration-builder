import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSpec } from "../src/spec/load.js";
import { createMockTransport } from "../src/sandbox/mockServer.js";
import { createSdk, SandboxViolation, SandboxLimit, ApiError } from "../src/sandbox/sdk.js";
import { transpile } from "../src/sandbox/transpile.js";

const spec = parseSpec(readFileSync(new URL("../fixtures/calendly-api.yaml", import.meta.url), "utf8"));
const now = new Date("2026-11-06T00:00:00Z");
const BASE = "https://api.calendly.com";
const mk = (over = {}) => {
  const entries = [];
  const sdk = createSdk({
    baseUrl: BASE,
    allowedHost: "api.calendly.com",
    transport: createMockTransport(spec, { now }),
    log: (e) => entries.push(e),
    ...over,
  });
  return { sdk, entries };
};

test("GET to another host is blocked", async () => {
  const { sdk } = mk();
  await assert.rejects(sdk.http.get("https://evil.com/x"), (e) => e instanceof SandboxViolation && e.kind === "violation" && /evil\.com/.test(e.message));
});

test("write methods are blocked", async () => {
  const { sdk } = mk();
  for (const m of ["post", "put", "patch", "delete"]) {
    await assert.rejects(sdk.http[m]("/x"), (e) => e instanceof SandboxViolation && e.message === `Blocked: write request (${m.toUpperCase()})`);
  }
});

test("non-2xx throws ApiError", async () => {
  const { sdk } = mk();
  await assert.rejects(sdk.http.get("/nope"), (e) => e instanceof ApiError && e.kind === "api" && e.status === 404);
});

test("runaway pager stops at 50 pages", async () => {
  const { sdk } = mk();
  const gen = sdk.paginate("/organization_memberships", { next: () => "x", items: (r) => r.collection });
  await assert.rejects(async () => { for await (const _ of gen); }, (e) => e instanceof SandboxLimit && e.kind === "limit" && /50 pages of \/organization_memberships/.test(e.message));
});

test("maxRecords limit per stream", async () => {
  const { sdk } = mk({ limits: { maxPages: 50, maxRecords: 5 } });
  const gen = sdk.paginate("/organization_memberships", { query: { count: 20 }, next: (r) => r.pagination.next_page_token, items: (r) => r.collection });
  await assert.rejects(async () => { for await (const _ of gen); }, (e) => e instanceof SandboxLimit && /Stopped after 5 records/.test(e.message));
});

test("defineConnector validates", () => {
  const { sdk } = mk();
  assert.throws(() => sdk.defineConnector({}), /app/);
  const def = { app: "a", baseUrl: BASE, users() {}, usage() {} };
  assert.equal(sdk.defineConnector(def), def);
});

test("log entries for requests and log()", async () => {
  const { sdk, entries } = mk();
  await sdk.http.get("/users/me");
  sdk.log("hello");
  assert.equal(entries[0].method, "GET");
  assert.equal(entries[0].path, "/users/me");
  assert.equal(entries[0].status, 200);
  assert.equal(typeof entries[0].t, "number");
  assert.equal(typeof entries[0].ms, "number");
  assert.equal(entries[0].records, undefined);
  assert.deepEqual({ ...entries[1], t: 0 }, { t: 0, level: "info", message: "hello" });
});

test("golden connector runs end to end against the mock", async () => {
  const { sdk, entries } = mk();
  const code = transpile(readFileSync(new URL("../fixtures/calendly.connector.ts", import.meta.url), "utf8"));
  const mod = { exports: {} };
  new Function("require", "module", "exports", code)(() => sdk, mod, mod.exports);
  const def = mod.exports.default;
  const ctx = { since: "2026-08-01T00:00:00Z", state: {} };
  const users = [];
  for await (const u of def.users(ctx)) users.push(u);
  assert.equal(new Set(users.map((u) => u.email)).size, 48);
  assert.ok(ctx.state.org);
  const usage = [];
  for await (const u of def.usage(ctx)) usage.push(u);
  assert.ok(usage.length > 0 && usage.every((u) => u.email && u.at));
  const pages = entries.filter((e) => e.records !== undefined);
  assert.ok(pages.length >= 2);
});
