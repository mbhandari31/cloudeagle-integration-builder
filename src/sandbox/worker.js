// Module Worker that runs one connector. Relative imports only (no import map in workers).
//
// runBrowser.js starts this file through a tiny blob: module, so the worker inherits the
// page's Content-Security-Policy (script-src 'self' blob:, no 'unsafe-eval'). Everything
// below is defence in depth on top of that policy.
import { executeConnector } from "./execute.js";

const BLOCKED_CODE = "Blocked: dynamic code";

// Captured before lockdown: connector code must not be able to message the main thread
// or mint its own blob: modules.
const post = self.postMessage.bind(self);
const createObjectURL = URL.createObjectURL.bind(URL);
const revokeObjectURL = URL.revokeObjectURL.bind(URL);
const BlobCtor = Blob;
const addListener = self.addEventListener.bind(self);
const removeListener = self.removeEventListener.bind(self);

function remove(name, root = self) {
  for (let o = root; o; o = Object.getPrototypeOf(o)) {
    try { delete o[name]; } catch {}
  }
  try { Object.defineProperty(root, name, { value: undefined, writable: false, configurable: false }); } catch {}
}

// 1. Network-capable globals (and postMessage) are removed before any connector code is compiled.
const BLOCKED = [
  "fetch", "XMLHttpRequest", "WebSocket", "WebSocketStream", "EventSource", "importScripts",
  "indexedDB", "WebTransport", "Worker", "SharedWorker", "BroadcastChannel", "caches",
  "FontFace", "postMessage",
];
for (const name of BLOCKED) remove(name);

// 2. Dynamic-code paths. The CSP already refuses eval-like calls; these make them fail
// even if the worker were ever started without that policy.
remove("eval");
remove("createObjectURL", URL);
const blockedCode = () => { throw new Error(BLOCKED_CODE); };
const codeCtors = [
  function () {}, async function () {}, function* () {}, async function* () {},
].map((f) => Object.getPrototypeOf(f));
for (const proto of codeCtors) {
  try { Object.defineProperty(proto, "constructor", { get: blockedCode, set: blockedCode, configurable: false }); } catch {}
}
remove("Function");
for (const name of ["setTimeout", "setInterval"]) {
  const original = self[name].bind(self);
  const guarded = (fn, ...rest) => {
    if (typeof fn !== "function") throw new Error(BLOCKED_CODE);
    return original(fn, ...rest);
  };
  try { Object.defineProperty(self, name, { value: guarded, writable: false, configurable: false }); } catch {}
}

// Compiles the transpiled connector as a blob: module (allowed by script-src blob:),
// so no 'unsafe-eval' is needed.
async function compile(js) {
  const src = `export default function (require, exports, module) {\n${js}\n}`;
  const url = createObjectURL(new BlobCtor([src], { type: "text/javascript" }));
  try {
    const mod = await import(url);
    return mod.default;
  } finally {
    revokeObjectURL(url);
  }
}

const pending = new Map();
let nextId = 0;

// Transport RPC: the main thread answers with the mock server.
const transport = ({ method, url }) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    post({ type: "request", id, method, url });
  });

addListener("message", ({ data }) => {
  if (data?.type !== "response") return;
  const resolve = pending.get(data.id);
  pending.delete(data.id);
  resolve?.({ status: data.status, json: data.json });
});

// Exactly one "run" message is accepted; the listener removes itself before any connector
// code exists, so connector code can't replay or hijack it.
async function onRun({ data }) {
  if (data?.type !== "run") return;
  removeListener("message", onRun);
  const { js, baseUrl, allowedHost, now, timeoutMs } = data;
  const result = await executeConnector(js, {
    compile,
    sdkOptions: { baseUrl, allowedHost, transport },
    now: new Date(now),
    timeoutMs,
  });
  try {
    post({ type: "done", result });
  } catch (e) {
    // Records that cannot be structured-cloned (functions, symbols...).
    post({ type: "done", result: { users: [], usage: [], log: result.log, error: { kind: "runtime", message: String(e?.message ?? e) } } });
  }
}
addListener("message", onRun);
