// Browser runner: transpile on the main thread, execute in a module Worker,
// answer the worker's transport RPCs with the mock server.
import { transpile } from "./transpile.js";
import { createMockTransport } from "./mockServer.js";

const GRACE_MS = 1000; // the worker's own soft timeout fires first and keeps partial results
const failed = (kind, message) => ({ users: [], usage: [], log: [], error: { kind, message } });

export function runInBrowser(tsCode, { spec, plan, now = new Date(), timeoutMs = 15000 } = {}) {
  let js;
  try {
    js = transpile(tsCode);
  } catch (e) {
    return Promise.resolve(failed("compile", String(e?.message ?? e)));
  }
  const transport = createMockTransport(spec, { now });

  return new Promise((resolve) => {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };
    // Hard stop: also catches busy loops that never yield back to the worker's event loop.
    const timer = setTimeout(() => finish(failed("timeout", `Stopped after ${timeoutMs / 1000} s`)), timeoutMs + GRACE_MS);

    worker.onmessage = async ({ data }) => {
      if (data?.type === "done") return finish(data.result);
      if (data?.type !== "request") return;
      let res;
      try {
        res = await transport({ method: data.method, url: data.url });
      } catch (e) {
        res = { status: 500, json: { message: String(e?.message ?? e) } };
      }
      if (!done) worker.postMessage({ type: "response", id: data.id, status: res.status, json: res.json });
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      finish(failed("runtime", e.message || "Sandbox worker failed to start"));
    };

    worker.postMessage({ js, baseUrl: plan.baseUrl, allowedHost: new URL(plan.baseUrl).host, now: +new Date(now), timeoutMs });
  });
}
