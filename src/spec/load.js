import yaml from "js-yaml";

export class SpecError extends Error {
  constructor(message) {
    super(message);
    this.name = "SpecError";
  }
}

const BAD_URL = "Couldn't read an OpenAPI spec at this URL";
const SWAGGER_2 = "This builder supports OpenAPI 3.x specs. Swagger 2.0 isn't supported yet.";

export function parseSpec(text) {
  let doc;
  try {
    doc = yaml.load(String(text)); // YAML is a superset of JSON
  } catch (e) {
    throw new SpecError(BAD_URL);
  }
  if (!doc || typeof doc !== "object") throw new SpecError(BAD_URL);
  // Summaries, slicing and the mock all read OpenAPI 3 shapes (servers, content[...].schema).
  if (doc.swagger && !doc.openapi) throw new SpecError(SWAGGER_2);
  if (!/^3\./.test(String(doc.openapi ?? ""))) throw new SpecError(BAD_URL);
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
