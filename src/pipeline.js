// Orchestrates read -> plan -> generate -> static -> mock -> validate, with up to 3 repairs.
// No bare imports, no Node-only APIs: runs in Node and the browser. The runner, AI client,
// fetch and clock are injected.
import { loadSpec } from "./spec/load.js";
import { summarizeSpec } from "./spec/summarize.js";
import { sliceSpec } from "./spec/slice.js";
import { triagePrompt, generatePrompt, repairPrompt, extractCode } from "./ai/prompts.js";
import { staticCheck } from "./sandbox/staticChecks.js";
import { validateRecords } from "./sandbox/validate.js";

const MAX_REPAIRS = 3;
const LADDER = ["read", "plan", "generate", "static", "mock", "validate"];
const LOOP_STAGES = ["generate", "static", "mock", "validate"];
const FAILURE_NAMES = { generate: "GenerationError", static: "StaticCheckFailed", mock: "MockRunFailed", validate: "ValidationFailed" };

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
// Keeps an HTTP status (e.g. the Anthropic SDK's AuthenticationError.status) so the UI can map it.
const errorOf = (e) => ({
  name: e?.name || "Error",
  message: String(e?.message ?? e),
  ...(typeof e?.status === "number" ? { status: e.status } : {}),
});

function httpsHost(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return u.protocol === "https:" ? u.host : null;
  } catch {
    return null;
  }
}

export async function runPipeline(
  { specUrl, spec, wants = ["users", "usage"], ai, runner, now = new Date(), fetchImpl },
  onEvent = () => {},
) {
  const ladder = new Map();
  const result = {
    status: "passed", failedStage: null, error: null,
    plan: null, code: null, attempts: 0, ladder: [], run: null, validation: null,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const emit = (e) => onEvent(e);
  const stage = (name, status, detail) => {
    if (LADDER.includes(name) && status !== "start") ladder.set(name, { stage: name, status, detail });
    emit({ type: "stage", stage: name, status, detail });
  };
  const addUsage = (u) => {
    result.usage.inputTokens += u?.input_tokens ?? 0;
    result.usage.outputTokens += u?.output_tokens ?? 0;
  };
  const finish = () => {
    result.ladder = LADDER.filter((s) => ladder.has(s)).map((s) => ladder.get(s));
    return result;
  };
  const fail = (name, error, ladderStage = name) => {
    result.status = "failed";
    result.failedStage = ladderStage;
    result.error = error;
    stage(name, "fail", error.message);
    if (name !== ladderStage) ladder.set(ladderStage, { stage: ladderStage, status: "fail", detail: error.message });
    emit({ type: "stage", stage: "failed", status: "fail", detail: error.message });
    return finish();
  };

  // 1. Read the spec.
  stage("read", "start", specUrl ? `Reading ${specUrl}` : "Reading the spec");
  let summary;
  try {
    if (!spec) spec = await loadSpec(specUrl, fetchImpl);
    summary = summarizeSpec(spec);
  } catch (e) {
    return fail("read", errorOf(e));
  }
  stage("read", "pass", `Found ${summary.title || "API"}: ${plural(summary.endpoints.length, "endpoint")}`);

  // 2. Plan.
  stage("plan", "start", "Choosing endpoints");
  let plan;
  try {
    const res = await ai.triage(triagePrompt(summary, wants));
    addUsage(res.usage);
    plan = res.plan;
  } catch (e) {
    return fail("plan", errorOf(e));
  }
  result.plan = plan;
  const allowedHost = httpsHost(plan?.baseUrl);
  if (!allowedHost) return fail("plan", { name: "PlanError", message: "The plan has no valid https base URL" });
  if (!Array.isArray(plan.endpoints) || plan.endpoints.length === 0) {
    return fail("plan", { name: "PlanError", message: "The plan has no endpoints" });
  }
  const style = plan.pagination?.style ? `pagination ${plan.pagination.style}` : "no pagination";
  let slicedSpec;
  try {
    slicedSpec = sliceSpec(spec, plan.endpoints.map((e) => ({ method: String(e?.method).toLowerCase(), path: e?.path })));
  } catch (e) {
    return fail("plan", errorOf(e));
  }
  if (Object.keys(slicedSpec.paths).length === 0) {
    return fail("plan", { name: "PlanError", message: "None of the planned endpoints exist in the spec" });
  }
  stage("plan", "pass", `Plan: ${plural(plan.endpoints.length, "endpoint")}, ${style}`);

  // 3. Generate, then check / run / validate; any failure goes back to the model as a repair.
  let code;
  let failure = null;
  for (let n = 1; n <= MAX_REPAIRS + 1; n++) {
    for (const s of LOOP_STAGES) ladder.delete(s);
    result.code = null;
    result.run = null;
    result.validation = null;
    const genStage = n === 1 ? "generate" : "repair";
    stage(genStage, "start", n === 1 ? "Writing the connector" : `Attempt ${n}: fixing the ${failure.stage} failure`);
    let text;
    try {
      const prompt = n === 1
        ? generatePrompt(plan, slicedSpec)
        : repairPrompt(code, failure, { plan, slicedSpec });
      const res = await (n === 1 ? ai.generate(prompt) : ai.repair(prompt));
      addUsage(res.usage);
      text = res.text;
    } catch (e) {
      result.attempts = n;
      return fail(genStage, errorOf(e), "generate");
    }
    result.attempts = n;

    try {
      code = extractCode(text);
    } catch (e) {
      code = undefined;
      emit({ type: "attempt", n, code: null });
      failure = { stage: "generate", message: e.message, details: [] };
      stage(genStage, "fail", `Attempt ${n}: ${e.message}`);
      if (genStage !== "generate") ladder.set("generate", { stage: "generate", status: "fail", detail: `Attempt ${n}: ${e.message}` });
      continue;
    }
    result.code = code;
    emit({ type: "attempt", n, code });
    const lines = code.split("\n").length;
    stage(genStage, "pass", `Attempt ${n}: ${plural(lines, "line")} of TypeScript`);
    if (genStage !== "generate") ladder.set("generate", { stage: "generate", status: "pass", detail: `Attempt ${n}: ${plural(lines, "line")} of TypeScript` });

    stage("static", "start", `Attempt ${n}: scanning the code`);
    let check;
    try {
      check = staticCheck(code, { allowedHost });
    } catch (e) {
      return fail("static", errorOf(e));
    }
    if (!check.ok) {
      const list = check.issues.map((i) => `${i.rule}, line ${i.line}`).join("; ");
      const message = `Static check found ${plural(check.issues.length, "issue")}`;
      failure = { stage: "static", message, details: check.issues };
      stage("static", "fail", `Attempt ${n}: static check found ${plural(check.issues.length, "issue")} (${list})`);
      continue;
    }
    stage("static", "pass", `Attempt ${n}: no issues`);

    stage("mock", "start", `Attempt ${n}: running on mock data`);
    let run;
    try {
      run = await runner(code, { spec, plan, now });
    } catch (e) {
      run = { error: { kind: "runtime", message: errorOf(e).message } };
    }
    run = { ...run, users: run?.users ?? [], usage: run?.usage ?? [], log: run?.log ?? [], error: run?.error ?? null };
    result.run = run;
    if (run.error) {
      const message = `${run.error.kind} error: ${run.error.message}`;
      failure = { stage: "mock", message, details: { error: run.error, log: run.log.slice(-10) } };
      stage("mock", "fail", `Attempt ${n}: ${message}`);
      continue;
    }
    stage("mock", "pass", `${plural(run.users.length, "user")}, ${plural(run.usage.length, "usage event")} from mock data`);

    stage("validate", "start", "Checking the records");
    let validation;
    try {
      validation = validateRecords({ users: run.users, usage: run.usage }, { now });
    } catch (e) {
      return fail("validate", errorOf(e));
    }
    result.validation = validation;
    if (!validation.ok) {
      failure = { stage: "validate", message: validation.errors.join("; "), details: validation.errors };
      stage("validate", "fail", `Attempt ${n}: ${failure.message}`);
      continue;
    }
    stage("validate", "pass", `${validation.stats.users} people, ${validation.stats.inactive90d} inactive for 90 days`);

    stage("done", "pass", `Connector passed after ${plural(n, "attempt")}`);
    return finish();
  }

  // Out of repairs: keep the last failure.
  result.status = "failed";
  result.failedStage = failure.stage;
  result.error = { name: FAILURE_NAMES[failure.stage], message: failure.message };
  emit({ type: "stage", stage: "failed", status: "fail", detail: failure.message });
  return finish();
}
