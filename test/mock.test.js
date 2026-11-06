import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSpec } from "../src/spec/load.js";
import { createMockTransport } from "../src/sandbox/mockServer.js";
import { PEOPLE, ACTIVE_COUNT } from "../src/sandbox/people.js";

const spec = parseSpec(readFileSync(new URL("../fixtures/calendly-api.yaml", import.meta.url), "utf8"));
const now = new Date("2026-11-06T00:00:00Z");
const BASE = "https://api.calendly.com";

test("people pool shape", () => {
  assert.equal(PEOPLE.length, 48);
  assert.equal(ACTIVE_COUNT, 37);
  assert.equal(new Set(PEOPLE.map((p) => p.email)).size, 48);
  assert.ok(PEOPLE.every((p) => /^[a-z]+\.[a-z]+@northwind\.health$/.test(p.email)));
});

test("memberships page through exactly 48 unique users", async () => {
  const t = createMockTransport(spec, { now });
  let url = `${BASE}/organization_memberships?count=20`;
  const emails = [];
  let pages = 0;
  while (url) {
    const r = await t({ method: "get", url });
    assert.equal(r.status, 200);
    emails.push(...r.json.collection.map((m) => m.user.email));
    url = r.json.pagination.next_page;
    if (!url) assert.equal(r.json.pagination.next_page_token, null);
    pages++;
  }
  assert.equal(pages, 3);
  assert.equal(emails.length, 48);
  assert.equal(new Set(emails).size, 48);
});

test("count=100 returns all 48 in one page with null next", async () => {
  const t = createMockTransport(spec, { now });
  const r = await t({ method: "GET", url: `${BASE}/organization_memberships?count=100` });
  assert.equal(r.json.collection.length, 48);
  assert.equal(r.json.pagination.next_page, null);
  assert.equal(r.json.pagination.next_page_token, null);
});

test("next_page is a full url carrying an opaque p<N> token", async () => {
  const t = createMockTransport(spec, { now });
  const r = await t({ method: "GET", url: `${BASE}/organization_memberships?count=20` });
  assert.equal(r.json.pagination.next_page_token, "p2");
  const u = new URL(r.json.pagination.next_page);
  assert.equal(u.searchParams.get("page_token"), "p2");
  assert.equal(u.searchParams.get("count"), "20");
});

test("scheduled_events: attendees are active people, start_time within 90 days", async () => {
  const t = createMockTransport(spec, { now });
  const active = new Set(PEOPLE.slice(0, ACTIVE_COUNT).map((p) => p.email));
  let url = `${BASE}/scheduled_events?count=100`;
  let total = 0;
  while (url) {
    const r = await t({ method: "GET", url });
    for (const ev of r.json.collection) {
      total++;
      const ts = new Date(ev.start_time).getTime();
      assert.ok(ts <= now.getTime() && ts >= now.getTime() - 90 * 864e5, ev.start_time);
      assert.ok(ev.event_memberships.length >= 1);
      for (const m of ev.event_memberships) assert.ok(active.has(m.user_email), m.user_email);
    }
    url = r.json.pagination.next_page;
  }
  assert.equal(total, 120);
});

test("single-object response is synthesised once", async () => {
  const t = createMockTransport(spec, { now });
  const r = await t({ method: "GET", url: `${BASE}/users/me` });
  assert.equal(r.status, 200);
  assert.equal(r.json.resource.email, PEOPLE[0].email);
});

test("path templates match {uuid} segments", async () => {
  const t = createMockTransport(spec, { now });
  const r = await t({ method: "GET", url: `${BASE}/users/abc-123` });
  assert.equal(r.status, 200);
});

test("unknown path gives 404", async () => {
  const t = createMockTransport(spec, { now });
  assert.equal((await t({ method: "GET", url: `${BASE}/nope` })).status, 404);
});

test("is deterministic", async () => {
  const a = await createMockTransport(spec, { now })({ method: "GET", url: `${BASE}/scheduled_events` });
  const b = await createMockTransport(spec, { now })({ method: "GET", url: `${BASE}/scheduled_events` });
  assert.deepEqual(a, b);
});

test("response without schema returns {status:200, json:{}}", async () => {
  const bare = { openapi: "3.1.0", paths: { "/ping": { get: { responses: { 200: { description: "ok" } } } } } };
  const r = await createMockTransport(bare, { now })({ method: "GET", url: "https://x.test/ping" });
  assert.deepEqual(r, { status: 200, json: {} });
});

test("OpenAPI 3.1 type arrays use first non-null type; enum first value", async () => {
  const s = { openapi: "3.1.0", paths: { "/t": { get: { responses: { 200: { content: { "application/json": { schema: {
    type: "object", properties: { a: { type: ["null", "integer"] }, b: { type: "string", enum: ["x", "y"] }, c: { type: "boolean" } } } } } } } } } } };
  const r = await createMockTransport(s, { now })({ method: "GET", url: "https://x.test/t" });
  assert.deepEqual(r.json, { a: 1, b: "x", c: true });
});

// ---------- Non-Calendly list shapes (small inline OpenAPI 3 specs) ----------
const json200 = (schema) => ({ responses: { 200: { content: { "application/json": { schema } } } } });
const userItem = { type: "object", properties: { id: { type: "string" }, email: { type: "string", format: "email" }, name: { type: "string" } } };
const q = (name, extra = {}) => ({ name, in: "query", schema: { type: "integer", ...extra } });

test("offset/limit with {data, has_more}: pages through all 48 users", async () => {
  const s = { openapi: "3.0.3", paths: { "/users": { get: {
    parameters: [q("offset"), q("limit", { default: 25 })],
    ...json200({ type: "object", properties: { data: { type: "array", items: userItem }, has_more: { type: "boolean" }, total: { type: "integer" } } }),
  } } } };
  const t = createMockTransport(s, { now });
  const emails = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    const r = await t({ method: "GET", url: `https://x.test/users?offset=${offset}&limit=20` });
    assert.equal(r.status, 200);
    emails.push(...r.json.data.map((d) => d.email));
    assert.equal(r.json.total, 48);
    pages++;
    if (!r.json.has_more) break;
    offset += r.json.data.length;
  }
  assert.equal(pages, 3);
  assert.equal(emails.length, 48);
  assert.equal(new Set(emails).size, 48);
  // Without a limit the declared default applies.
  const d = await t({ method: "GET", url: "https://x.test/users" });
  assert.equal(d.json.data.length, 25);
  assert.equal(d.json.has_more, true);
  // Past the end: empty page, has_more false.
  const end = await t({ method: "GET", url: "https://x.test/users?offset=48&limit=20" });
  assert.deepEqual([end.json.data.length, end.json.has_more], [0, false]);
});

test("page/per_page: pages through 120 records with has_more", async () => {
  const s = { openapi: "3.0.3", paths: { "/events": { get: {
    parameters: [q("page"), q("per_page")],
    ...json200({ type: "object", properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } }, has_more: { type: "boolean" }, page: { type: "integer" } } }),
  } } } };
  const t = createMockTransport(s, { now });
  const ids = [];
  for (let page = 1; ; page++) {
    const r = await t({ method: "GET", url: `https://x.test/events?page=${page}&per_page=50` });
    assert.equal(r.json.page, page);
    ids.push(...r.json.items.map((x) => x.id));
    if (!r.json.has_more) break;
  }
  assert.equal(ids.length, 120);
  assert.equal(new Set(ids).size, 120);
});

test("root array response expands to the pool and honours offset paging", async () => {
  const s = { openapi: "3.1.0", paths: { "/members": { get: {
    parameters: [q("offset"), q("limit")],
    ...json200({ type: "array", items: userItem }),
  } } } };
  const t = createMockTransport(s, { now });
  const first = await t({ method: "GET", url: "https://x.test/members?limit=30" });
  assert.ok(Array.isArray(first.json));
  assert.equal(first.json.length, 30);
  const rest = await t({ method: "GET", url: "https://x.test/members?offset=30&limit=30" });
  assert.equal(rest.json.length, 18);
  assert.equal(new Set([...first.json, ...rest.json].map((p) => p.email)).size, 48);
});

test("a list with no paging parameters returns the whole pool at once", async () => {
  const s = { openapi: "3.1.0", paths: {
    "/users": { get: json200({ type: "array", items: userItem }) },
    "/projects": { get: json200({ type: "object", properties: { results: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } } } }) },
  } };
  const t = createMockTransport(s, { now });
  assert.equal((await t({ method: "GET", url: "https://x.test/users" })).json.length, 48);
  assert.equal((await t({ method: "GET", url: "https://x.test/projects" })).json.results.length, 120);
});

test("a top-level cursor field gets cursor paging", async () => {
  const s = { openapi: "3.1.0", paths: { "/users": { get: {
    parameters: [{ name: "cursor", in: "query", schema: { type: "string" } }, q("limit")],
    ...json200({ type: "object", properties: { users: { type: "array", items: userItem }, next_cursor: { type: ["string", "null"] } } }),
  } } } };
  const t = createMockTransport(s, { now });
  let url = "https://x.test/users?limit=20";
  const emails = [];
  for (;;) {
    const r = await t({ method: "GET", url });
    emails.push(...r.json.users.map((x) => x.email));
    if (!r.json.next_cursor) break;
    url = `https://x.test/users?limit=20&cursor=${r.json.next_cursor}`;
  }
  assert.equal(emails.length, 48);
  assert.equal(new Set(emails).size, 48);
});
