import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { staticCheck } from "../src/sandbox/staticChecks.js";
import { transpile } from "../src/sandbox/transpile.js";

const opts = { allowedHost: "api.calendly.com" };
const rules = (code) => staticCheck(code, opts).issues.map((i) => i.rule);

test("golden connector is clean", () => {
  const src = readFileSync(new URL("../fixtures/calendly.connector.ts", import.meta.url), "utf8");
  const r = staticCheck(src, opts);
  assert.deepEqual(r.issues, []);
  assert.equal(r.ok, true);
});

const cases = [
  ["network-global", 'await fetch("x")'],
  ["network-global", "new XMLHttpRequest()"],
  ["network-global", "new WebSocket(u)"],
  ["network-global", "new EventSource(u)"],
  ["network-global", "importScripts(u)"],
  ["network-global", "navigator.sendBeacon(u)"],
  ["escape", "globalThis.x"],
  ["escape", "self.postMessage(1)"],
  ["escape", "window.x"],
  ["escape", "eval(s)"],
  ["escape", "Function(s)"],
  ["escape", "({}).constructor.constructor('x')"],
  ["escape", "process.env"],
  ["escape", "require('fs')"],
  ["dynamic-import", 'import("x")'],
  ["foreign-import", 'import fs from "fs";'],
  ["write-call", 'http.post("/x")'],
  ["write-call", 'http.delete("/x")'],
  ["foreign-host", 'const u = "https://evil.com/x";'],
  ["secret-access", "const k = ctx.apiKey;"],
  ["secret-access", "let token = 1;"],
  ["secret-access", 'h["Authorization"]; const Authorization = 1;'],
];
for (const [rule, code] of cases) {
  test(`flags ${rule}: ${code}`, () => {
    const r = staticCheck(code, opts);
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.rule === rule), JSON.stringify(r.issues));
  });
}

test("comments and strings are ignored by code rules", () => {
  assert.deepEqual(rules('// http.post(x)\n/* apiKey */ const s = "http.post( apiKey";'), []);
  assert.deepEqual(rules("const s = `http.post( ${1}`;"), []);
});

test("allowed host and token property reads pass", () => {
  assert.deepEqual(rules('const u = "https://api.calendly.com/x?y=1";'), []);
  assert.deepEqual(rules("const t = res.pagination.next_page_token;"), []);
  assert.deepEqual(rules("const x = { page_token: 1 };"), []);
});

test("sdk import allowed, line numbers are 1-based", () => {
  const r = staticCheck('import { http } from "@cloudeagle/connector-sdk";\n\nfetch(1);', opts);
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].line, 3);
  assert.equal(r.issues[0].rule, "network-global");
});

test("transpile strips types and converts imports", () => {
  const out = transpile('import { http } from "@cloudeagle/connector-sdk";\nconst a: number = http.x; export default a;');
  assert.ok(!out.includes(": number"));
  assert.ok(out.includes("require("));
});

test("regex literals cannot hide code", () => {
  assert.ok(rules('/a\\//; fetch("x")').includes("network-global"));
  assert.ok(rules("/'/.test(s); globalThis.fetch(u)").some((r) => r === "network-global" || r === "escape"));
  assert.ok(rules("/[/']/.test(s); eval(x)").includes("escape"));
  assert.deepEqual(rules("const r = /fetch\\(/g; const d = a / b / c;"), []);
});

test("arrow function parameter named token is clean", () => {
  assert.deepEqual(rules("const o = { next: token => token.next };"), []);
});

test("dangerous rules fail closed on raw source (division misread as regex)", () => {
  for (const c of ["let i=0; i++ / 2; fetch(x) / 3;", "let i=0; i-- / 2; fetch(x) / 3;", "let y = {}/1; fetch(x)/1;"]) {
    assert.ok(rules(c).includes("network-global"), c);
  }
  assert.equal(staticCheck("fetch(1)", opts).issues.length, 1, "deduped by rule+line");
});
