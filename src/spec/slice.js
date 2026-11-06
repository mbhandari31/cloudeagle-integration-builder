import { deref } from "./refs.js";

export function sliceSpec(spec, endpoints) {
  const paths = {};
  for (const { method, path } of endpoints) {
    const item = spec.paths?.[path];
    const op = item?.[method];
    if (!op) continue;
    const full = { ...op };
    if (item.parameters) full.parameters = [...item.parameters, ...(op.parameters || [])];
    (paths[path] ||= {})[method] = deref(spec, full);
  }
  return {
    openapi: spec.openapi,
    info: spec.info,
    servers: spec.servers || [],
    components: { securitySchemes: deref(spec, spec.components?.securitySchemes || {}) },
    paths,
  };
}
