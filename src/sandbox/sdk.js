// Connector SDK runtime. No imports, no Node-only APIs: runs inside a Worker.
export class SandboxViolation extends Error {
  constructor(message) { super(message); this.name = "SandboxViolation"; this.kind = "violation"; }
}
export class SandboxLimit extends Error {
  constructor(message) { super(message); this.name = "SandboxLimit"; this.kind = "limit"; }
}
export class ApiError extends Error {
  constructor(status, body) {
    super(`API error ${status}`);
    this.name = "ApiError"; this.kind = "api"; this.status = status; this.body = body;
  }
}

export function createSdk({ baseUrl, allowedHost, transport, log: sink = () => {}, limits = {} }) {
  const { maxPages = 50, maxRecords = 5000 } = limits;
  const t0 = Date.now();
  const now = () => (globalThis.performance ? performance.now() : Date.now());

  async function get(path, query, records) {
    const url = new URL(path, baseUrl);
    if (url.protocol !== "https:" || url.host !== allowedHost) {
      throw new SandboxViolation(`Blocked: ${url.protocol}//${url.host} is not https://${allowedHost}`);
    }
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const start = now();
    const res = await transport({ method: "get", url: url.toString() });
    const entry = {
      t: Date.now() - t0, method: "GET", path: url.pathname, status: res.status,
      ms: Math.round(now() - start),
    };
    const ok = res.status >= 200 && res.status < 300;
    if (records && ok) entry.records = records(res.json);
    sink(entry);
    if (!ok) throw new ApiError(res.status, res.json);
    return res.json;
  }

  const blocked = (m) => async () => { throw new SandboxViolation(`Blocked: write request (${m})`); };
  const http = {
    get: (path, query) => get(path, query),
    post: blocked("POST"), put: blocked("PUT"), patch: blocked("PATCH"), delete: blocked("DELETE"),
  };

  async function* paginate(path, { query, next, tokenParam = "page_token", items, map } = {}) {
    let token = null;
    let count = 0;
    for (let page = 1; ; page++) {
      if (page > maxPages) throw new SandboxLimit(`Stopped after ${maxPages} pages of ${path}`);
      const abs = typeof token === "string" && /^https?:\/\//i.test(token);
      const res = abs
        ? await get(token, undefined, (j) => (items(j) || []).length)
        : await get(path, token ? { ...query, [tokenParam]: token } : query, (j) => (items(j) || []).length);
      for (const item of items(res) || []) {
        const mapped = map ? map(item) : item;
        for (const rec of Array.isArray(mapped) ? mapped : [mapped]) {
          if (rec === null || rec === undefined) continue;
          if (++count > maxRecords) throw new SandboxLimit(`Stopped after ${maxRecords} records of ${path}`);
          yield rec;
        }
      }
      token = next(res);
      if (!token) return;
    }
  }

  function defineConnector(def) {
    if (!def || typeof def !== "object") throw new Error("defineConnector: expected an object");
    for (const k of ["app", "baseUrl"]) {
      if (typeof def[k] !== "string" || !def[k]) throw new Error(`defineConnector: missing "${k}"`);
    }
    for (const k of ["users", "usage"]) {
      if (typeof def[k] !== "function") throw new Error(`defineConnector: "${k}" must be an async generator function`);
    }
    return def;
  }

  const log = (message) => sink({ t: Date.now() - t0, level: "info", message: String(message) });
  return { defineConnector, http, paginate, log };
}
