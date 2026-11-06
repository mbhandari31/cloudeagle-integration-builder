// Runs a compiled connector against the SDK. No bare imports, no Node-only APIs:
// loaded inside a module Worker as well as in Node.
import { createSdk, SandboxViolation, SandboxLimit, ApiError } from "./sdk.js";

const SDK_NAME = "@cloudeagle/connector-sdk";
const DAY = 864e5;

class StageError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

function toError(e) {
  if (e instanceof StageError || e instanceof SandboxViolation || e instanceof SandboxLimit || e instanceof ApiError) {
    return { kind: e.kind, message: e.message };
  }
  return { kind: "runtime", message: String(e && typeof e === "object" && "message" in e ? e.message : e) };
}

export async function executeConnector(js, { compile, sdkOptions, now = new Date(), timeoutMs = 15000 }) {
  const users = [];
  const usage = [];
  const log = [];
  const sdk = createSdk({ ...sdkOptions, log: (entry) => log.push(entry) });

  const run = async () => {
    let fn;
    try {
      fn = await compile(js); // sync (Node vm) or async (browser blob module)
    } catch (e) {
      throw new StageError("compile", String(e?.message ?? e));
    }
    const require = (name) => {
      if (name === SDK_NAME) return sdk;
      throw new SandboxViolation(`Blocked: import of ${name}`);
    };
    const exports = {};
    const module = { exports };
    fn(require, exports, module);
    const connector = module.exports?.default ?? exports.default;
    if (!connector || typeof connector.users !== "function" || typeof connector.usage !== "function") {
      throw new Error("Connector must export default defineConnector({ users, usage })");
    }
    const ctx = { since: new Date(+new Date(now) - 90 * DAY).toISOString(), state: {} };
    // Per-stream cap: the SDK's maxRecords only covers a single paginate() call.
    const maxRecords = sdkOptions?.limits?.maxRecords ?? 5000;
    const drain = async (name, out) => {
      for await (const rec of connector[name](ctx)) {
        if (out.length >= maxRecords) throw new SandboxLimit(`Stopped after ${maxRecords} records of ${name}`);
        out.push(rec);
      }
    };
    await drain("users", users);
    await drain("usage", usage);
  };

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new StageError("timeout", `Stopped after ${timeoutMs / 1000} s`)), timeoutMs);
  });
  let error = null;
  try {
    await Promise.race([run(), timeout]);
  } catch (e) {
    error = toError(e);
  } finally {
    clearTimeout(timer);
  }
  return { users: [...users], usage: [...usage], log: [...log], error };
}
