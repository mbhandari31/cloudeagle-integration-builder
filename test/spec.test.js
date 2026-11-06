import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSpec, loadSpec, SpecError } from "../src/spec/load.js";
import { summarizeSpec } from "../src/spec/summarize.js";
import { sliceSpec } from "../src/spec/slice.js";

const spec = parseSpec(readFileSync(new URL("../fixtures/calendly-api.yaml", import.meta.url), "utf8"));

test("summarizeSpec counts 65 operations", () => {
  assert.equal(summarizeSpec(spec).endpoints.length, 65);
});
test("summarizeSpec lists servers", () => {
  assert.ok(summarizeSpec(spec).servers.includes("https://api.calendly.com"));
});
test("GET /organization_memberships has organizations:read scope", () => {
  const e = summarizeSpec(spec).endpoints.find((x) => x.method === "get" && x.path === "/organization_memberships");
  assert.ok(e.scopes.includes("organizations:read"));
  assert.ok(e.params.includes("page_token"));
});
test("sliceSpec is self-contained and dereferenced", () => {
  const s = JSON.stringify(sliceSpec(spec, [{ method: "get", path: "/organization_memberships" }]));
  assert.ok(s.includes("next_page_token"));
  assert.ok(!s.includes("$ref"));
});
test("parseSpec rejects non-spec", () => {
  assert.throws(() => parseSpec("<html>"), SpecError);
});
test("loadSpec wraps fetch failure", async () => {
  await assert.rejects(loadSpec("http://x", async () => { throw new Error("net"); }), SpecError);
});
