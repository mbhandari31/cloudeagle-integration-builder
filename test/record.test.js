import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { record } from "../scripts/record.mjs";

const yaml = readFileSync(new URL("../fixtures/calendly-api.yaml", import.meta.url), "utf8");
const golden = readFileSync(new URL("../fixtures/calendly.connector.ts", import.meta.url), "utf8");
const PLAN = {
  appName: "calendly", baseUrl: "https://api.calendly.com",
  auth: { type: "oauth2", scopes: ["users:read"], notes: "OAuth bearer" },
  endpoints: [
    { purpose: "setup", method: "GET", path: "/users/me", why: "organization URI" },
    { purpose: "users", method: "GET", path: "/organization_memberships", why: "members" },
    { purpose: "usage", method: "GET", path: "/scheduled_events", why: "activity proxy" },
  ],
  pagination: { style: "cursor", tokenParam: "page_token", nextField: "pagination.next_page_token" },
  fieldMapping: [], limitations: [],
};
const usage = { input_tokens: 10, output_tokens: 5 };

class FakeAnthropic {
  constructor(opts) {
    this.messages = { create: async () => ({ content: [{ type: "text", text: JSON.stringify(PLAN) }], usage, stop_reason: "end_turn" }) };
    this.beta = { messages: { create: async () => ({ content: [{ type: "text", text: `\`\`\`ts\n${golden}\`\`\`\n` }], usage, stop_reason: "end_turn" }) } };
  }
}

test("record writes a clean recording for a passing run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "record-"));
  const outPath = join(dir, "nested", "calendly.json");
  const lines = [];
  const apiKey = "fake-key-for-test-0000";
  const { result } = await record({
    apiKey, Anthropic: FakeAnthropic, now: new Date("2026-11-06T00:00:00Z"), outPath,
    fetchImpl: async () => ({ ok: true, text: async () => yaml }),
    log: (l) => lines.push(l),
  });
  assert.equal(result.status, "passed");
  const text = await readFile(outPath, "utf8");
  const rec = JSON.parse(text);
  assert.equal(rec.result.status, "passed");
  assert.equal(rec.calls.length, 2);
  assert.equal(rec.result.stats.users, 48);
  assert.equal(rec.recordedAt, "2026-11-06T00:00:00.000Z");
  assert.ok(!text.includes('"apiKey"'));
  assert.ok(!text.includes(apiKey));
  assert.deepEqual(Object.keys(rec.calls[0].request), ["model", "system", "messages"]);
  assert.ok(lines.some((l) => l.startsWith("[read] pass — ")));
  assert.ok(lines.includes("attempt 1"));
});
