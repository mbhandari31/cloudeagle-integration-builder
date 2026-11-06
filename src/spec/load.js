import yaml from "js-yaml";

export class SpecError extends Error {
  constructor(message) {
    super(message);
    this.name = "SpecError";
  }
}

const BAD_URL = "Couldn't read an OpenAPI spec at this URL";

export function parseSpec(text) {
  let doc;
  try {
    doc = yaml.load(String(text)); // YAML is a superset of JSON
  } catch (e) {
    throw new SpecError(BAD_URL);
  }
  if (!doc || typeof doc !== "object" || !(doc.openapi || doc.swagger)) {
    throw new SpecError(BAD_URL);
  }
  return doc;
}

export async function loadSpec(url, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseSpec(await res.text());
  } catch (e) {
    if (e instanceof SpecError) throw e;
    throw new SpecError(BAD_URL);
  }
}
