// Pure HTML builders for the builder page. Every value that came from the network,
// the model or the generated code goes through esc().
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const CHECK = `<svg width="12" height="12" viewBox="0 0 10 10" aria-hidden="true"><path d="m2 5 2 2 4-4" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>`;
const CROSS = `<svg width="12" height="12" viewBox="0 0 10 10" aria-hidden="true"><path d="m3 3 4 4m0-4-4 4" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>`;
const WARN = `<svg class="ico" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3 2 17h16L10 3Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 8v4m0 2.5v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

// ---------- Stepper ----------
export const STEPS = ["Point at docs", "Review plan", "Generate", "Test in sandbox", "Results"];

export function stepper(current, { failed = false, done = false } = {}) {
  return STEPS.map((label, i) => {
    let cls = "";
    let dot = String(i + 1);
    if (done || i < current) { cls = "done"; dot = CHECK; }
    else if (i === current && failed) { cls = "current failed"; dot = CROSS; }
    else if (i === current) cls = "current";
    return `<div class="step ${cls}"><span class="dot">${dot}</span>${esc(label)}<span class="bar"></span></div>`;
  }).join("");
}

// ---------- Plan ----------
const TARGETS = {
  "User.email": "User email", "User.name": "User name", "User.role": "Role", "User.externalId": "User ID",
  "UsageEvent.email": "Activity: who", "UsageEvent.at": "Activity: when",
};
const CONF = { high: ["b-green", "High"], medium: ["b-amber", "Medium"], low: ["b-red", "Low"] };

function endpointLabel(endpoint, plan) {
  const s = String(endpoint ?? "").trim();
  if (/^[A-Z]+\s+\//.test(s)) return s;
  const hit = (plan.endpoints || []).find((e) => e?.path === s);
  return hit ? `${String(hit.method).toUpperCase()} ${s}` : s;
}

export function planTable(plan) {
  const rows = plan.fieldMapping || [];
  if (!rows.length) return `<p class="empty">The plan has no field mapping.</p>`;
  return `<table class="plan-table">
    <thead><tr><th>CloudEagle field</th><th>Comes from</th><th>Confidence</th><th>Source</th></tr></thead>
    <tbody>${rows.map((m) => {
      const [cls, label] = CONF[m.confidence] || ["b-grey", m.confidence || "Unknown"];
      return `<tr class="${m.confidence === "high" ? "" : "flag"}">
        <td><b>${esc(TARGETS[m.target] || m.target)}</b></td>
        <td><span class="mono src-path">${esc(m.source)}</span>${m.note ? `<div class="sub">${esc(m.note)}</div>` : ""}</td>
        <td><span class="badge ${cls}">${esc(label)}</span></td>
        <td><span class="cite">${esc(endpointLabel(m.endpoint, plan))}</span></td>
      </tr>`;
    }).join("")}</tbody>
  </table>`;
}

export function planReviewCount(plan) {
  const n = (plan.fieldMapping || []).filter((m) => m.confidence !== "high").length;
  return n ? `${plural(n, "field")} ${n === 1 ? "needs" : "need"} a quick look` : "All fields high confidence";
}

export function endpointList(plan) {
  return `<ul class="endpoints">${(plan.endpoints || []).map((e) => `<li>
    <span class="cite">${esc(String(e.method).toUpperCase())} ${esc(e.path)}</span>
    <span class="badge b-grey">${esc(e.purpose)}</span>
    <span class="why">${esc(e.why)}</span></li>`).join("")}</ul>`;
}

export function limitations(plan) {
  const items = plan.limitations || [];
  if (!items.length) return "";
  return `<div class="note note-amber">${WARN}<div><b>What this API can't give us</b>${
    items.map((l) => `<p>${esc(l)}</p>`).join("")}</div></div>`;
}

export function scopes(plan) {
  const list = plan.auth?.scopes || [];
  const badges = list.length
    ? list.map((s) => `<span class="badge b-green">${esc(s)}</span>`).join("")
    : `<span class="badge b-grey">No scopes listed</span>`;
  return `<p class="small">Auth: ${esc(plan.auth?.type || "unknown")}. Read only; the runtime blocks writes.</p>
    <div class="badges">${badges}</div>${plan.auth?.notes ? `<p class="small muted-note">${esc(plan.auth.notes)}</p>` : ""}`;
}

// ---------- Ladder ----------
export const RUNGS = [
  { stage: "static", name: "Code checks", idle: "Scans for network access, writes and secrets" },
  { stage: "mock", name: "Practice run on generated data", idle: "Runs in a locked-down worker against data generated from the spec" },
  { stage: "validate", name: "Output matches CloudEagle's schema", idle: "Valid emails, ISO dates, activity matches users" },
];

export function ladder(state) {
  const live = RUNGS.map((r, i) => {
    const s = state[r.stage] || { status: "wait" };
    const cls = { pass: "pass", fail: "fail", now: "now", wait: "wait" }[s.status];
    const node = s.status === "pass" ? CHECK : s.status === "fail" ? CROSS : String(i + 1);
    return `<li class="${cls}"><span class="node">${node}</span><div class="body">
      <div class="name">${esc(r.name)}${s.status === "now" ? `<span class="badge b-blue">Running</span>` : ""}</div>
      <div class="what">${esc(s.detail || r.idle)}</div></div></li>`;
  });
  const later = [
    ["7-day shadow sync", "Full sync, kept out of reports"],
    ["Live", "Daily sync with health checks"],
  ].map(([name, what], i) => `<li class="wait later"><span class="node">${i + 4}</span><div class="body">
      <div class="name">${name}<span class="badge b-grey">Next, in production</span></div>
      <div class="what">${what}</div></div></li>`);
  return live.concat(later).join("");
}

export function ladderBadge(state) {
  const n = RUNGS.filter((r) => state[r.stage]?.status === "pass").length;
  const failed = RUNGS.some((r) => state[r.stage]?.status === "fail");
  return `<span class="badge ${failed ? "b-red" : n ? "b-green" : "b-grey"}">${n} of 5 passed</span>`;
}

export function attemptList(attempts, finalStatus) {
  if (!attempts.length) return `<p class="small">No attempts yet.</p>`;
  return `<ol class="attempts">${attempts.map((a, i) => {
    const last = i === attempts.length - 1;
    let text;
    if (a.status === "pass") text = "passed all checks";
    else if (a.status === "fail") {
      const tail = !last ? (finalStatus === "passed" ? " → repaired" : " → sent back for repair") : "";
      text = `${a.outcome}${tail}`;
    } else text = a.outcome || "running";
    const cls = a.status === "pass" ? "ok" : a.status === "fail" ? "bad" : "";
    return `<li class="${cls}"><b>Attempt ${a.n}:</b> ${esc(text)}</li>`;
  }).join("")}</ol>`;
}

// ---------- Results ----------
const DAY = 864e5;
const fmtDate = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function statCards(validation, run) {
  const s = validation.stats;
  return [
    ["People found", s.users, ""],
    ["Activity events", run.usage.length, ""],
    ["Active in last 90 days", s.users - s.inactive90d, ""],
    ["No activity in 90 days", s.inactive90d, "warn"],
  ].map(([label, value, cls]) => `<div class="panel panel-pad stat ${cls}"><p>${label}</p><h1 data-stat="${esc(label)}">${esc(value)}</h1></div>`).join("");
}

export function dataTable(validation, now) {
  const cutoff = +new Date(now) - 90 * DAY;
  return `<table class="data-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last active</th><th>Check</th></tr></thead>
  <tbody>${validation.rows.map((r) => {
    const inactive = r.lastActive === null || Date.parse(r.lastActive) < cutoff;
    return `<tr${inactive ? ` class="inactive"` : ""}><td><b>${esc(r.name || "(no name)")}</b></td><td>${esc(r.email)}</td>
      <td>${esc(r.role || "")}</td><td>${r.lastActive ? esc(fmtDate(r.lastActive)) : "None in 90 days"}</td>
      <td>${inactive ? `<span class="badge b-grey">No activity in 90 days</span>` : `<span class="badge b-green">Active</span>`}</td></tr>`;
  }).join("")}</tbody></table>`;
}

// ---------- Code with gutter citations ----------
const SOURCE_RE = /\s*\/\/\s*source:\s*(.+?)\s*$/;
const KEYWORDS = /^(import|from|export|default|const|let|var|async|await|yield|return|interface|type|function|if|else|for|of|in|new|null|undefined|true|false|any|string)$/;
const TOKEN_RE = /(\/\/.*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b([A-Za-z_$][\w$]*)\b(?=\s*\()|\b([A-Za-z_$][\w$]*)\b/g;

export function splitCitations(code) {
  return String(code).replace(/\n$/, "").split("\n").map((line) => {
    const m = SOURCE_RE.exec(line);
    return m ? { text: line.slice(0, m.index), cite: m[1] } : { text: line, cite: null };
  });
}

function highlight(text) {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    out += esc(text.slice(last, m.index));
    const [tok, comment, str, call, word] = m;
    if (comment) out += `<span class="cm">${esc(comment)}</span>`;
    else if (str) out += `<span class="s">${esc(str)}</span>`;
    else if (call) out += KEYWORDS.test(call) ? `<span class="k">${esc(call)}</span>` : `<span class="f">${esc(call)}</span>`;
    else if (word && KEYWORDS.test(word)) out += `<span class="k">${esc(word)}</span>`;
    else out += esc(tok);
    last = m.index + tok.length;
  }
  return out + esc(text.slice(last));
}

export function codeView(code) {
  const lines = splitCitations(code);
  return lines.map((l, i) => `<div class="ln${l.cite ? " cited" : ""}"><span class="n">${i + 1}</span><span class="c">${highlight(l.text)}</span><span class="src">${
    l.cite ? `<span title="${esc(l.cite)}">${esc(l.cite)}</span>` : ""}</span></div>`).join("");
}

// ---------- Run log ----------
export function runLog(log) {
  if (!log?.length) return `<p class="empty">The sandbox wrote no log entries.</p>`;
  return `<table class="log-table"><thead><tr><th>Time</th><th>Request or message</th><th>Status</th><th>Records</th><th>Duration</th></tr></thead>
  <tbody>${log.map((e) => `<tr>
    <td class="mono">${esc((e.t / 1000).toFixed(2))} s</td>
    <td>${e.method ? `<span class="mono">${esc(e.method)} ${esc(e.path)}</span>` : esc(e.message)}</td>
    <td>${e.status === undefined ? "" : `<span class="badge ${e.status < 300 ? "b-green" : "b-red"}">${esc(e.status)}</span>`}</td>
    <td>${esc(e.records ?? "")}</td>
    <td>${e.ms === undefined ? "" : `${esc(e.ms)} ms`}</td></tr>`).join("")}</tbody></table>`;
}

// ---------- Errors ----------
const STAGE_NAMES = { read: "Reading the docs", plan: "Planning", generate: "Generating code", static: "Code checks", mock: "Practice run", validate: "Schema check" };

export function errorNote(result, hint) {
  const where = STAGE_NAMES[result.failedStage] || result.failedStage || "Run";
  return `<div class="note note-red" role="alert">${WARN}<div><b>${esc(where)} failed</b><p>${esc(result.error?.message || "Unknown error")}</p>${
    hint ? `<p class="hint-line">${esc(hint)}</p>` : ""}</div></div>`;
}
