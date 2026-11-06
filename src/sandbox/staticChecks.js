// Static pre-flight scan of connector source. No imports: loads inside a Worker.
const SDK = "@cloudeagle/connector-sdk";

// Blank comments and string/template literal contents (keeping newlines and quotes so
// offsets and line numbers stay stable); collect string literals for the host scan.
function scan(src) {
  let code = "";
  const strings = [];
  const braces = []; // stack: true = template ${ } expression
  let i = 0;
  const n = src.length;
  const blank = (s) => s.replace(/[^\n]/g, " ");
  const readString = (quote, start) => {
    let j = start + 1;
    while (j < n && src[j] !== quote && !(quote !== "`" && src[j] === "\n")) j += src[j] === "\\" ? 2 : 1;
    return j;
  };
  const template = (start) => {
    // start is just after the opening backtick or after a closing "}" of ${}
    let j = start;
    while (j < n && src[j] !== "`" && !(src[j] === "$" && src[j + 1] === "{")) j += src[j] === "\\" ? 2 : 1;
    const text = src.slice(start, Math.min(j, n));
    strings.push({ value: text, index: start });
    code += blank(text);
    if (src[j] === "`") { code += "`"; i = j + 1; }
    else if (j < n) { code += "${"; braces.push(true); i = j + 2; }
    else i = n;
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") {
      const e = src.indexOf("\n", i);
      const end = e < 0 ? n : e;
      code += blank(src.slice(i, end)); i = end;
    } else if (c === "/" && d === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      code += blank(src.slice(i, end)); i = end;
    } else if (c === '"' || c === "'") {
      const j = readString(c, i);
      strings.push({ value: src.slice(i + 1, j), index: i + 1 });
      code += c + blank(src.slice(i + 1, j)) + (src[j] === c ? c : "");
      i = j + 1;
    } else if (c === "`") {
      code += "`"; i++; template(i);
    } else if (c === "{") { braces.push(false); code += c; i++; }
    else if (c === "}") {
      if (braces.pop() === true) { code += "}"; i++; template(i); }
      else { code += c; i++; }
    } else { code += c; i++; }
  }
  return { code, strings };
}

const CODE_RULES = [
  ["network-global", /(?<![.\w$])fetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bimportScripts\b|\bnavigator\s*\.\s*sendBeacon\b/g, "Direct network access is not allowed; use the SDK http helper"],
  ["escape", /\bglobalThis\b|(?<![.\w$])self\s*\.|(?<![.\w$])window\s*\.|(?<![.\w$])eval\s*\(|(?<![.\w$])Function\s*\(|\.\s*constructor\b|(?<![.\w$])process\s*\.|(?<![.\w$])require\s*\(/g, "Access to globals or the sandbox boundary is not allowed"],
  ["dynamic-import", /\bimport\s*\(/g, "Dynamic import is not allowed"],
  ["write-call", /\bhttp\s*\.\s*(?:post|put|patch|delete)\b/g, "Write requests are not allowed; connectors are read-only"],
  ["secret-access", /\bapiKey\b|\bAuthorization\b|(?<![\w$.])token\s*=(?!=)/g, "Connectors must not touch credentials"],
];

export function staticCheck(code, { allowedHost } = {}) {
  const { code: clean, strings } = scan(code);
  const lineAt = (idx) => {
    let l = 1;
    for (let k = 0; k < idx; k++) if (code.charCodeAt(k) === 10) l++;
    return l;
  };
  const issues = [];
  const add = (rule, idx, message) => issues.push({ rule, line: lineAt(idx), message });

  for (const [rule, re, message] of CODE_RULES) {
    for (const m of clean.matchAll(re)) add(rule, m.index, `${message}: ${m[0].trim()}`);
  }

  // Import specifiers: find `import ... from "x"` / `import "x"` / `export ... from "x"`.
  for (const m of clean.matchAll(/\b(?:import|export)\b(?!\s*\()[^;]*?(?:\bfrom\s*|\bimport\s*)(["'])/g)) {
    const q = m.index + m[0].length - 1;
    const s = strings.find((x) => x.index === q + 1);
    if (s && s.value !== SDK) add("foreign-import", q, `Import of "${s.value}" is not allowed; only ${SDK}`);
  }

  for (const s of strings) {
    for (const m of s.value.matchAll(/https?:\/\/([^/\s:?#"'`\\]+)/gi)) {
      if (m[1].toLowerCase() !== String(allowedHost).toLowerCase()) {
        add("foreign-host", s.index + m.index, `URL host ${m[1]} is not ${allowedHost}`);
      }
    }
    if (s.value === "constructor" || s.value === "__proto__") add("escape", s.index, `Access to "${s.value}" is not allowed`);
    if (/^authorization$/i.test(s.value)) add("secret-access", s.index, "Connectors must not touch credentials: Authorization");
  }

  issues.sort((a, b) => a.line - b.line);
  return { ok: issues.length === 0, issues };
}
