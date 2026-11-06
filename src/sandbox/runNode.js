// Node runner: transpile, then compile into a fresh vm context with only JS builtins.
// Node-only (node:vm); the browser uses runBrowser.js + worker.js instead.
import vm from "node:vm";
import { transpile } from "./transpile.js";
import { createMockTransport } from "./mockServer.js";
import { executeConnector } from "./execute.js";

function compile(js) {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: true, wasm: false } });
  return vm.runInContext(`(function (require, exports, module) {\n${js}\n})`, context, { filename: "connector.js" });
}

// opts.transport / opts.timeoutMs are optional overrides (tests).
export async function runInNode(tsCode, { spec, plan, now = new Date(), transport, timeoutMs } = {}) {
  let js;
  try {
    js = transpile(tsCode);
  } catch (e) {
    return { users: [], usage: [], log: [], error: { kind: "compile", message: String(e?.message ?? e) } };
  }
  return executeConnector(js, {
    compile,
    sdkOptions: {
      baseUrl: plan.baseUrl,
      allowedHost: new URL(plan.baseUrl).host,
      transport: transport ?? createMockTransport(spec, { now }),
    },
    now,
    timeoutMs,
  });
}
