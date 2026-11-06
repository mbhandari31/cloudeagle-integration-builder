// Page controller: mode switch, key handling, running the pipeline, progressive rendering.
import { runPipeline } from "../pipeline.js";
import { createAiClient } from "../ai/client.js";
import { runInBrowser } from "../sandbox/runBrowser.js";
import * as R from "./render.js";

const CALENDLY_SPEC = "https://developer.calendly.com/openapi/calendly-api.yaml";
const SPEC_SNAPSHOT = "fixtures/calendly-api.yaml"; // used only if the live spec can't be fetched in replay
const KEY_STORE = "ce-anthropic-key";
const REPLAY_SPEED = 4;
const URL_HINT = { replay: "Recorded run uses Calendly. Switch to Live to try another API.", live: "Paste an OpenAPI (JSON or YAML) URL" };

const SUBTITLE = document.getElementById("subtitle").textContent;
const $ = (id) => document.getElementById(id);
const ui = {
  form: $("start-form"), url: $("spec-url"), urlHint: $("url-hint"), key: $("api-key"),
  forget: $("forget-key"), run: $("run-btn"), skip: $("skip-btn"), status: $("status"),
  missing: $("replay-missing"), error: $("error"), stepper: $("stepper"),
  title: $("title"), subtitle: $("subtitle"),
  planSection: $("plan-section"), planTitle: $("plan-title"), planSub: $("plan-sub"),
  planCount: $("plan-count"), planTable: $("plan-table"), limitations: $("limitations"), endpoints: $("endpoints"),
  results: $("results-section"), stats: $("stat-cards"), dataPane: $("data-pane"), codePane: $("code-pane"),
  logPane: $("log-pane"), codeFile: $("code-file"),
  ladder: $("ladder"), ladderBadge: $("ladder-badge"), attempts: $("attempts"),
  scopesPanel: $("scopes-panel"), scopes: $("scopes"), footer: $("footer-stats"), footerMode: $("footer-mode"),
};

const session = {
  get: () => { try { return sessionStorage.getItem(KEY_STORE) || ""; } catch { return ""; } },
  set: (v) => { try { v ? sessionStorage.setItem(KEY_STORE, v) : sessionStorage.removeItem(KEY_STORE); } catch {} },
};

let mode = "replay";
let recording = null; // null = not loaded yet, false = missing
let running = false;
let skipWaiting = null; // resolves pending replay delays when "Skip waiting" is pressed

// ---------- Mode ----------
function setMode(next) {
  if (running) return;
  mode = next;
  for (const b of document.querySelectorAll(".seg button")) b.setAttribute("aria-checked", String(b.dataset.mode === mode));
  const live = mode === "live";
  document.querySelector(".live-only").hidden = !live;
  ui.url.readOnly = !live;
  ui.url.value = live ? (ui.url.dataset.live || CALENDLY_SPEC) : (recording?.specUrl || CALENDLY_SPEC);
  ui.urlHint.textContent = URL_HINT[mode];
  ui.missing.hidden = live || recording !== false;
  ui.run.disabled = !live && !recording;
  ui.run.textContent = live ? "Build connector" : "Play recorded run";
  ui.footerMode.textContent = live ? "Live: calls Claude with your key" : recording ? `Recorded run from ${new Date(recording.recordedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : "";
}

for (const b of document.querySelectorAll(".seg button")) b.addEventListener("click", () => setMode(b.dataset.mode));
ui.url.addEventListener("input", () => { if (mode === "live") ui.url.dataset.live = ui.url.value; });
ui.key.value = session.get();
ui.key.addEventListener("input", () => session.set(ui.key.value.trim()));
ui.forget.addEventListener("click", () => { session.set(""); ui.key.value = ""; ui.key.focus(); });

// ---------- Tabs ----------
for (const t of document.querySelectorAll(".tab[data-tab]")) {
  t.addEventListener("click", () => {
    for (const o of document.querySelectorAll(".tab[data-tab]")) {
      o.classList.toggle("on", o === t);
      o.setAttribute("aria-selected", String(o === t));
    }
    for (const p of document.querySelectorAll(".tab-body")) p.hidden = p.dataset.pane !== t.dataset.tab;
    ui.codeFile.hidden = t.dataset.tab !== "code";
  });
}

// ---------- Run state and rendering ----------
let st;
function resetState() {
  st = { step: 0, failed: false, done: false, rungs: {}, attempts: [], tokensIn: 0, tokensOut: 0, models: new Set(), plan: null };
  ui.error.innerHTML = "";
  ui.planSection.hidden = true;
  ui.results.hidden = true;
  ui.scopesPanel.hidden = true;
  ui.codePane.innerHTML = "";
  ui.logPane.innerHTML = "";
  ui.stats.innerHTML = "";
  ui.dataPane.innerHTML = "";
  ui.codeFile.textContent = "";
  ui.title.textContent = "Build a connector from API docs";
  ui.subtitle.textContent = SUBTITLE;
  paint();
}

function paint() {
  ui.stepper.innerHTML = R.stepper(st.step, { failed: st.failed, done: st.done });
  ui.ladder.innerHTML = R.ladder(st.rungs);
  ui.ladderBadge.innerHTML = R.ladderBadge(st.rungs);
  ui.attempts.innerHTML = R.attemptList(st.attempts, st.final);
  const models = [...st.models];
  const stats = st.attempts.length || st.tokensIn
    ? `${st.attempts.length} ${st.attempts.length === 1 ? "attempt" : "attempts"} · tokens ${st.tokensIn.toLocaleString("en-US")} in / ${st.tokensOut.toLocaleString("en-US")} out${models.length ? ` · models: ${models.join(", ")}` : ""}`
    : "";
  const stopped = st.stoppedAt ? `Last run stopped at ${st.stoppedAt}.` : "";
  ui.footer.textContent = [stopped, stats].filter(Boolean).join(" ") || (st.ran ? "" : "No run yet.");
}

function showPlan(plan) {
  st.plan = plan;
  const app = plan.appName ? plan.appName[0].toUpperCase() + plan.appName.slice(1) : "the API";
  ui.title.textContent = `Here's what we'll read from ${app}`;
  ui.subtitle.textContent = "Claude read the docs and drafted this plan. CloudEagle checks the code it writes before you see any data.";
  ui.planTitle.textContent = "The plan";
  const n = (plan.endpoints || []).length;
  ui.planSub.textContent = `${st.readDetail ? `${st.readDetail}. ` : ""}Claude picked ${n} ${n === 1 ? "endpoint" : "endpoints"}. Each field links to the endpoint it comes from.`;
  ui.planCount.textContent = R.planReviewCount(plan);
  ui.planTable.innerHTML = R.planTable(plan);
  ui.limitations.innerHTML = R.limitations(plan);
  ui.endpoints.innerHTML = R.endpointList(plan);
  ui.scopes.innerHTML = R.scopes(plan);
  ui.planSection.hidden = false;
  ui.scopesPanel.hidden = false;
  ui.codeFile.textContent = `${plan.appName || "connector"}.connector.ts`;
}

const STEP_OF = { read: 0, plan: 1, generate: 2, repair: 2, static: 3, mock: 3, validate: 3, done: 4 };
const stripAttempt = (s) => String(s ?? "").replace(/^Attempt \d+:\s*/, "");

function onEvent(e) {
  if (e.type === "attempt") { paint(); return; }
  if (e.type !== "stage") return;
  const { stage, status, detail } = e;
  if (stage in STEP_OF && status === "start") st.step = STEP_OF[stage];
  if (status === "start") ui.status.textContent = `${detail || stage}…`;

  if (stage === "read" && status === "pass") st.readDetail = detail;
  if ((stage === "generate" || stage === "repair") && status === "start") {
    st.attempts.push({ n: st.attempts.length + 1, status: "run", outcome: "writing code" });
    for (const r of R.RUNGS) delete st.rungs[r.stage];
  }
  const cur = st.attempts[st.attempts.length - 1];
  if ((stage === "generate" || stage === "repair") && status === "fail" && cur) Object.assign(cur, { status: "fail", outcome: stripAttempt(detail) });
  if (R.RUNGS.some((r) => r.stage === stage)) {
    st.rungs[stage] = { status: status === "start" ? "now" : status, detail: status === "start" ? stripAttempt(detail) : stripAttempt(detail) };
    if (status === "fail" && cur) Object.assign(cur, { status: "fail", outcome: stripAttempt(detail) });
    if (stage === "static" && status === "pass" && st.plan) st.rungs.static.detail = `Read-only, calls only ${hostOf(st.plan.baseUrl)}`;
  }
  if (stage === "done") {
    st.done = true;
    if (cur) cur.status = "pass";
    ui.status.textContent = detail;
  }
  if (stage === "failed") { st.failed = true; ui.status.textContent = "The run stopped."; }
  paint();
}

const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };

function showResults(result, now) {
  if (result.code) {
    ui.codePane.innerHTML = R.codeView(result.code);
  }
  ui.logPane.innerHTML = R.runLog(result.run?.log);
  if (result.validation && result.run) {
    ui.stats.innerHTML = R.statCards(result.validation, result.run);
    ui.dataPane.innerHTML = R.dataTable(result.validation, now);
  } else {
    ui.stats.innerHTML = "";
    ui.dataPane.innerHTML = `<p class="empty">No data: the connector didn't pass the checks.</p>`;
  }
  if (result.code || result.run) ui.results.hidden = false;
}

// Wraps the AI client: replay pacing with "Skip waiting", running token totals, the plan as soon as it exists.
function instrument(ai, { calls = null } = {}) {
  let i = 0;
  const wrap = (fn) => async (prompt) => {
    if (calls) {
      const ms = calls[i]?.ms ?? 0;
      if (ms > 0 && skipWaiting) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, ms / REPLAY_SPEED);
          skipWaiting.waiters.push(() => { clearTimeout(t); resolve(); });
        });
      }
    }
    const res = await fn(prompt);
    // Models that were actually called: the replayed call, or the live call the client just recorded.
    const c = calls ? calls[i++] : ai.recorder?.calls?.at(-1);
    const model = c?.response?.model || c?.request?.model;
    if (model) st.models.add(model);
    st.tokensIn += res.usage?.input_tokens ?? 0;
    st.tokensOut += res.usage?.output_tokens ?? 0;
    if (res.plan) showPlan(res.plan);
    paint();
    return res;
  };
  return { triage: wrap(ai.triage), generate: wrap(ai.generate), repair: wrap(ai.repair), recorder: ai.recorder };
}

async function loadAnthropic() {
  const mod = await import("@anthropic-ai/sdk");
  return mod.default ?? mod.Anthropic;
}

// In replay, fetch the recorded spec URL; fall back to the bundled snapshot if Calendly is unreachable.
async function replayFetch(url) {
  try {
    const res = await fetch(url);
    if (res.ok) return res;
  } catch {}
  return fetch(SPEC_SNAPSHOT);
}

async function start(ev) {
  ev?.preventDefault();
  if (running) return;
  resetState();
  const live = mode === "live";
  const specUrl = ui.url.value.trim();
  let ai;
  let now = new Date();
  let fetchImpl;
  try {
    if (live) {
      const apiKey = ui.key.value.trim();
      // The spec read happens before any AI call, so a bad URL fails even without a key.
      const Anthropic = apiKey ? await loadAnthropic() : class NoKey {
        constructor() { const fail = async () => { throw new Error("Add your Anthropic API key to run live."); }; this.messages = { create: fail }; this.beta = { messages: { create: fail } }; }
      };
      ai = createAiClient({ mode: "live", apiKey, Anthropic });
      fetchImpl = (u) => fetch(u);
    } else {
      // The client replays at full speed; instrument() paces it so "Skip waiting" can cut delays short.
      ai = createAiClient({ mode: "replay", recording, speed: Infinity });
      now = new Date(recording.recordedAt);
      fetchImpl = replayFetch;
    }
  } catch (e) {
    ui.error.innerHTML = R.errorNote({ failedStage: null, error: { message: e.message } });
    return;
  }

  running = true;
  ui.run.disabled = true;
  document.querySelectorAll(".seg button").forEach((b) => (b.disabled = true));
  skipWaiting = live ? null : { waiters: [] };
  ui.skip.hidden = live;
  ui.skip.disabled = false;
  const wrapped = instrument(ai, { calls: live ? null : recording.calls });
  st.ran = true;
  let result = { status: "failed" };
  try {
    try {
      result = await runPipeline({ specUrl, ai: wrapped, runner: runInBrowser, now, fetchImpl }, onEvent);
    } catch (e) {
      result = { status: "failed", failedStage: null, error: { message: e.message } };
    }
    renderOutcome(result, now);
  } catch (e) {
    ui.error.innerHTML = R.errorNote({ failedStage: null, error: { message: `Something went wrong showing the results: ${e?.message ?? e}` } });
  } finally {
    running = false;
    skipWaiting = null;
    ui.skip.hidden = true;
    ui.run.disabled = false;
    document.querySelectorAll(".seg button").forEach((b) => (b.disabled = false));
    try { paint(); } catch {}
    document.body.dataset.run = result.status; // for scripted checks
  }
}

function renderOutcome(result, now) {
  st.final = result.status;
  if (result.plan && !st.plan) showPlan(result.plan);
  showResults(result, now);
  if (result.status !== "passed") {
    st.failed = true;
    st.stoppedAt = (R.STAGE_NAMES[result.failedStage] || "an unexpected error").toLowerCase();
    let hint = result.failedStage === "read" ? URL_HINT.live : null;
    const msg = String(result.error?.message ?? "");
    if (result.error?.name === "AuthenticationError" || /^401\b/.test(msg)) {
      result = { ...result, error: { ...result.error, message: "Anthropic didn't accept this API key." } };
      hint = "Check the key, or use Forget key and paste it again.";
    }
    ui.error.innerHTML = R.errorNote(result, hint);
  } else {
    ui.results.scrollIntoView({ behavior: "smooth", block: "start" });
    ui.status.textContent = `Connector passed after ${result.attempts} ${result.attempts === 1 ? "attempt" : "attempts"}.`;
  }
}

ui.form.addEventListener("submit", start);
ui.skip.addEventListener("click", () => {
  if (!skipWaiting) return;
  skipWaiting.skip = true;
  ui.skip.disabled = true;
  // Infinity for the rest of the run: drop delays now and for every later call.
  const flush = () => { const w = skipWaiting?.waiters.splice(0) || []; w.forEach((f) => f()); };
  flush();
  skipWaiting.waiters.push = (f) => { f(); return 0; };
});

// ---------- Boot ----------
resetState();
setMode("replay");
fetch("recordings/calendly.json")
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((rec) => {
    if (!Array.isArray(rec?.calls)) throw new Error("Bad recording");
    recording = rec;
  })
  .catch(() => { recording = false; })
  .finally(() => { if (!running) setMode(mode); });
