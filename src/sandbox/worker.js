// Module Worker that runs one connector. Relative imports only (no import map in workers).
import { executeConnector } from "./execute.js";

// Network-capable globals are removed before any connector code is compiled.
const BLOCKED = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "WebTransport", "Worker"];
for (const name of BLOCKED) {
  try { delete self[name]; } catch {}
  try { Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false }); } catch {}
}

const post = self.postMessage.bind(self);
const pending = new Map();
let nextId = 0;

// Transport RPC: the main thread answers with the mock server.
const transport = ({ method, url }) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    post({ type: "request", id, method, url });
  });

self.addEventListener("message", async ({ data }) => {
  if (data?.type === "response") {
    const resolve = pending.get(data.id);
    pending.delete(data.id);
    resolve?.({ status: data.status, json: data.json });
    return;
  }
  const { js, baseUrl, allowedHost, now, timeoutMs } = data;
  const result = await executeConnector(js, {
    compile: (code) => new Function("require", "exports", "module", code),
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
});
