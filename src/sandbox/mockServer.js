import { deref } from "../spec/refs.js";
import { PEOPLE, ACTIVE_COUNT } from "./people.js";

const DAY = 864e5;
const SIZE_PARAMS = ["count", "limit", "per_page"];
const NEXT_KEYS = ["next_page_token", "next_cursor", "next_page"];

const firstType = (t) => (Array.isArray(t) ? t.find((x) => x !== "null") : t);

function mergeAllOf(schema) {
  if (!Array.isArray(schema.allOf)) return schema;
  const { allOf, ...rest } = schema;
  const out = { ...rest, properties: { ...(rest.properties || {}) } };
  for (const part of allOf.map(mergeAllOf)) {
    Object.assign(out, { ...part, properties: out.properties });
    Object.assign(out.properties, part.properties || {});
  }
  return out;
}

function normalize(schema) {
  let s = schema && typeof schema === "object" ? schema : {};
  s = mergeAllOf(s);
  const alt = s.oneOf || s.anyOf;
  if (Array.isArray(alt) && alt.length) s = normalize({ ...alt[0] });
  return s;
}

// ctx: { i: item index, j: index inside nested array, nested: bool, path }
function synth(schema, key, ctx, now) {
  const s = normalize(schema);
  if (s.enum?.length) return s.enum[0];
  const type = firstType(s.type) ?? (s.properties ? "object" : undefined);
  const person = ctx.nested ? PEOPLE[(ctx.i * 7 + ctx.j) % ACTIVE_COUNT] : PEOPLE[ctx.i % PEOPLE.length];
  switch (type) {
    case "object": {
      const out = {};
      for (const [k, v] of Object.entries(s.properties || {})) out[k] = synth(v, k, ctx, now);
      return out;
    }
    case "array":
      return [synth(s.items, key, { ...ctx, nested: true, j: 0 }, now)];
    case "integer":
    case "number":
      return ctx.i + 1;
    case "boolean":
      return true;
    case "string":
    default: {
      if (type !== "string" && type !== undefined) return null;
      if (s.format === "date-time") {
        return new Date(now.getTime() - ((ctx.i * 17 + ctx.j * 5) % 85) * DAY).toISOString();
      }
      if (s.format === "date") {
        return new Date(now.getTime() - ((ctx.i * 17 + ctx.j * 5) % 85) * DAY).toISOString().slice(0, 10);
      }
      if (s.format === "uri" || s.format === "url") return `https://api.example${ctx.path}/${ctx.i + 1}`;
      if (/email/i.test(key) || s.format === "email") return person.email;
      if (key === "name" || /(^|_)name$/.test(key)) return person.name;
      if (type === undefined) return {};
      return `${key || "value"}-${ctx.i + 1}`;
    }
  }
}

function matchPath(spec, pathname) {
  const base = (() => {
    try { return new URL(spec.servers?.[0]?.url ?? "").pathname.replace(/\/$/, ""); } catch { return ""; }
  })();
  let p = base && pathname.startsWith(base + "/") ? pathname.slice(base.length) : pathname;
  p = p.length > 1 ? p.replace(/\/$/, "") : p;
  const segs = p.split("/");
  let best = null;
  for (const [tpl, item] of Object.entries(spec.paths || {})) {
    const ts = tpl.split("/");
    if (ts.length !== segs.length) continue;
    let literals = 0;
    const ok = ts.every((t, k) => {
      if (/^\{[^}]+\}$/.test(t)) return segs[k] !== "";
      if (t === segs[k]) { literals++; return true; }
      return false;
    });
    if (ok && (!best || literals > best.literals)) best = { tpl, item, literals };
  }
  return best && { ...best, path: p };
}

function responseSchema(spec, op) {
  const responses = op.responses || {};
  const code = responses["200"] ? "200" : Object.keys(responses).find((c) => /^2/.test(c));
  const res = code && deref(spec, responses[code]);
  return res?.content?.["application/json"]?.schema;
}

function findCollection(schema) {
  const s = normalize(schema);
  const props = s.properties || {};
  const pag = Object.entries(props).find(
    ([, v]) => v && typeof v === "object" && NEXT_KEYS.some((k) => normalize(v).properties?.[k]),
  );
  const arr = Object.entries(props).find(([, v]) => firstType(normalize(v).type) === "array");
  return pag && arr ? { arrKey: arr[0], pagKey: pag[0], props } : null;
}

export function createMockTransport(spec, { now = new Date() } = {}) {
  return async function transport({ method, url }) {
    const u = new URL(url);
    const m = matchPath(spec, u.pathname);
    const op = m?.item?.[String(method).toLowerCase()];
    if (!op) return { status: 404, json: { title: "Not Found", message: "The requested resource was not found." } };

    const schema = responseSchema(spec, op);
    if (!schema) return { status: 200, json: {} };
    const base = { path: m.path, i: 0, j: 0, nested: false };

    const col = findCollection(schema);
    if (!col) return { status: 200, json: synth(schema, "", base, now) };

    const total = /member|user/.test(m.path) ? 48 : 120;
    const sizeParam = SIZE_PARAMS.find((k) => u.searchParams.has(k));
    const size = Math.max(1, parseInt(u.searchParams.get(sizeParam), 10) || 20);
    const params = [...(m.item.parameters || []), ...(op.parameters || [])].map((p) => deref(spec, p));
    const tokenParam = params.find((p) => p.in === "query" && /token|cursor/i.test(p.name))?.name ?? "page_token";
    const tok = u.searchParams.get(tokenParam);
    const page = Math.max(1, /^p(\d+)$/.exec(tok ?? "")?.[1] ?? 1);
    const start = Math.min((page - 1) * size, total);
    const end = Math.min(start + size, total);

    const pageUrl = (n) => {
      const nu = new URL(u);
      nu.searchParams.set(tokenParam, `p${n}`);
      return nu.toString();
    };
    const hasNext = end < total;
    const hasPrev = page > 1;
    const itemSchema = normalize(col.props[col.arrKey]).items;
    const items = [];
    for (let i = start; i < end; i++) items.push(synth(itemSchema, col.arrKey, { ...base, i }, now));

    const pagination = synth(col.props[col.pagKey], col.pagKey, base, now);
    const set = {
      count: items.length,
      next_page: hasNext ? pageUrl(page + 1) : null,
      next_page_token: hasNext ? `p${page + 1}` : null,
      next_cursor: hasNext ? `p${page + 1}` : null,
      previous_page: hasPrev ? pageUrl(page - 1) : null,
      previous_page_token: hasPrev ? `p${page - 1}` : null,
    };
    for (const k of Object.keys(set)) if (k in pagination) pagination[k] = set[k];

    const json = {};
    for (const [k, v] of Object.entries(col.props)) {
      json[k] = k === col.arrKey ? items : k === col.pagKey ? pagination : synth(v, k, base, now);
    }
    return { status: 200, json };
  };
}
