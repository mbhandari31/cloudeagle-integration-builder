export function resolveRef(spec, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return {};
  let node = spec;
  for (const part of ref.slice(2).split("/")) {
    node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (node === undefined) return {};
  }
  return node;
}

// Cycle-safe: a ref already on the current path, or beyond `depth` refs deep, becomes {}.
export function deref(spec, node, depth = 6) {
  const walk = (n, seen, left) => {
    if (Array.isArray(n)) return n.map((x) => walk(x, seen, left));
    if (!n || typeof n !== "object") return n;
    if (typeof n.$ref === "string") {
      if (left <= 0 || seen.includes(n.$ref)) return {};
      return walk(resolveRef(spec, n.$ref), [...seen, n.$ref], left - 1);
    }
    const out = {};
    for (const [k, v] of Object.entries(n)) out[k] = walk(v, seen, left);
    return out;
  };
  return walk(node, [], depth);
}
