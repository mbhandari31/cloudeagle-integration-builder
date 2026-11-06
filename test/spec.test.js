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
test("parseSpec rejects Swagger 2.0 with a clear message", () => {
  const swagger = "swagger: '2.0'\ninfo: { title: Old, version: '1' }\nhost: api.example.com\npaths: {}\n";
  assert.throws(() => parseSpec(swagger), (e) => e instanceof SpecError
    && e.message === "This builder supports OpenAPI 3.x specs. Swagger 2.0 isn't supported yet.");
});
test("loadSpec keeps the Swagger 2.0 message", async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify({ swagger: "2.0", info: {}, paths: {} }) });
  await assert.rejects(loadSpec("https://x", fetchImpl), { name: "SpecError", message: /OpenAPI 3\.x/ });
});
test("parseSpec accepts OpenAPI 3.1 and rejects an unknown version", () => {
  assert.equal(parseSpec("openapi: 3.1.0\ninfo: {title: t, version: '1'}\npaths: {}").openapi, "3.1.0");
  assert.throws(() => parseSpec("openapi: 4.0.0\npaths: {}"), SpecError);
});
