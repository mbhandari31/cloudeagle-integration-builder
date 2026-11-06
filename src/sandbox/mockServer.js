import { deref } from "../spec/refs.js";
import { PEOPLE, ACTIVE_COUNT } from "./people.js";

const DAY = 864e5;

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

// Response fields that carry a "next page" cursor (nested in a pagination object or top level).
const CURSOR_KEYS = ["next_page_token", "next_cursor", "next_page", "nextPageToken", "nextCursor", "next"];
const SIZE_PARAMS = ["count", "limit", "per_page", "page_size", "pageSize", "perPage"];
const TOTAL_KEYS = ["total", "total_count", "totalCount"];

const isObjectSchema = (s) => firstType(s.type) === "object" || (!s.type && !!s.properties);
function arrayOfObjects(schema) {
  const s = normalize(schema);
  return firstType(s.type) === "array" && isObjectSchema(normalize(s.items));
}

// Where the list lives in a response: a root array, or top-level array-of-objects properties,
// plus where (if anywhere) the cursor fields are.
function findCollection(schema) {
  const s = normalize(schema);
  if (arrayOfObjects(s)) return { root: true, itemSchema: normalize(s).items };
  const props = s.properties || {};
  const arrays = Object.keys(props).filter((k) => arrayOfObjects(props[k]));
  if (!arrays.length) return null;
  const pagKey = Object.keys(props).find((k) => {
    const v = normalize(props[k]);
    return !arrays.includes(k) && isObjectSchema(v) && CURSOR_KEYS.some((c) => v.properties?.[c]);
  });
  const rootCursor = CURSOR_KEYS.some((k) => k in props && !arrays.includes(k));
  return { root: false, props, arrays, pagKey, rootCursor };
}

const int = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

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

    // Paging style, from the response shape and the operation's query parameters.
    const total = /member|user/.test(m.path) ? 48 : 120;
    const params = [...(m.item.parameters || []), ...(op.parameters || [])].map((p) => deref(spec, p));
    const declared = new Set(params.filter((p) => p?.in === "query").map((p) => p.name));
    const has = (name) => declared.has(name) || u.searchParams.has(name);
    const cursor = !col.root && (!!col.pagKey || col.rootCursor);
    const style = cursor ? "cursor" : has("offset") ? "offset" : has("page") ? "page" : "none";

    const sizeParam = SIZE_PARAMS.find(has);
    const sizeDefault = int(params.find((p) => p?.name === sizeParam)?.schema?.default);
    const size = Math.max(1, int(u.searchParams.get(sizeParam)) ?? sizeDefault ?? (style === "none" && !sizeParam ? total : 20));

    const tokenParam = params.find((p) => p?.in === "query" && /token|cursor/i.test(p.name))?.name ?? "page_token";
    let page = 1;
    let start = 0;
    if (style === "cursor") {
      page = Math.max(1, int(/^p(\d+)$/.exec(u.searchParams.get(tokenParam) ?? "")?.[1]) ?? 1);
      start = (page - 1) * size;
    } else if (style === "offset") {
      start = Math.max(0, int(u.searchParams.get("offset")) ?? 0);
      page = Math.floor(start / size) + 1;
    } else if (style === "page") {
      page = Math.max(1, int(u.searchParams.get("page")) ?? 1);
      start = (page - 1) * size;
    }
    start = Math.min(start, total);
    const end = Math.min(start + size, total);
    const hasNext = end < total;
    const hasPrev = start > 0;

    const itemsFor = (itemSchema, key) => {
      const items = [];
      for (let i = start; i < end; i++) items.push(synth(itemSchema, key, { ...base, i }, now));
      return items;
    };
    if (col.root) return { status: 200, json: itemsFor(col.itemSchema, "") };

    const pageUrl = (n) => {
      const nu = new URL(u);
      nu.searchParams.set(tokenParam, `p${n}`);
      return nu.toString();
    };
    const cursorFields = {
      count: end - start,
      next_page: hasNext ? pageUrl(page + 1) : null,
      next_page_token: hasNext ? `p${page + 1}` : null,
      next_cursor: hasNext ? `p${page + 1}` : null,
      nextPageToken: hasNext ? `p${page + 1}` : null,
      nextCursor: hasNext ? `p${page + 1}` : null,
      next: hasNext ? pageUrl(page + 1) : null,
      previous_page: hasPrev ? pageUrl(page - 1) : null,
      previous_page_token: hasPrev ? `p${page - 1}` : null,
    };
    const overlay = (obj, fields) => {
      for (const k of Object.keys(fields)) if (k in obj) obj[k] = fields[k];
      return obj;
    };

    const json = {};
    for (const [k, v] of Object.entries(col.props)) {
      if (col.arrays.includes(k)) json[k] = itemsFor(normalize(v).items, k);
      else if (k === col.pagKey) json[k] = overlay(synth(v, k, base, now), cursorFields);
      else json[k] = synth(v, k, base, now);
    }
    // Top-level paging fields: cursors, has_more, totals and echoed offset/page/size.
    const rootFields = { has_more: hasNext, hasMore: hasNext };
    if (col.rootCursor) {
      for (const k of CURSOR_KEYS) rootFields[k] = cursorFields[k];
    }
    for (const k of TOTAL_KEYS) rootFields[k] = total;
    if (style === "offset") rootFields.offset = start;
    if (style === "page") rootFields.page = page;
    if (sizeParam && sizeParam !== "count") rootFields[sizeParam] = size;
    overlay(json, rootFields);
    return { status: 200, json };
  };
}
