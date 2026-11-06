import { transform } from "sucrase";

export function transpile(ts) {
  return transform(ts, { transforms: ["typescript", "imports"] }).code;
}
