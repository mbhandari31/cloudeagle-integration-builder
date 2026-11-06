import { resolveRef } from "./refs.js";

export const METHODS = ["get", "post", "put", "patch", "delete"];
const SCOPE_RE = /`([a-z_]+:read|[a-z_]+:write)`/g;

export function summarizeSpec(spec) {
  const endpoints = [];
  for (const [path, item] of Object.entries(spec.paths || {})) {
    for (const method of METHODS) {
      const op = item?.[method];
      if (!op) continue;
      const params = [...(item.parameters || []), ...(op.parameters || [])]
        .map((p) => (p.$ref ? resolveRef(spec, p.$ref) : p).name)
        .filter(Boolean);
      endpoints.push({
        method,
        path,
        summary: op.summary || "",
        scopes: [...new Set([...(op.description || "").matchAll(SCOPE_RE)].map((m) => m[1]))],
        params: [...new Set(params)],
      });
    }
  }
  return {
    title: spec.info?.title || "",
    servers: (spec.servers || []).map((s) => s.url),
    security: spec.components?.securitySchemes || {},
    endpoints,
  };
}
