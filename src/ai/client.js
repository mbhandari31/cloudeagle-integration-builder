// Claude client with live and replay modes. No bare imports: the Anthropic class is injected
// (CDN build in the browser, npm package in Node).
import { PLAN_SCHEMA } from "./prompts.js";

export class AiRefusalError extends Error {
  constructor(message) { super(message); this.name = "AiRefusalError"; this.kind = "refusal"; }
}
export class ReplayMismatch extends Error {
  constructor(message) { super(message); this.name = "ReplayMismatch"; }
}
export class ReplayExhausted extends Error {
  constructor(message) { super(message); this.name = "ReplayExhausted"; }
}

const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";

function checkRefusal(response) {
  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category;
    throw new AiRefusalError(`Claude declined the request${category ? ` (${category})` : ""}`);
  }
}

function usageOf(response) {
  const { input_tokens, output_tokens } = response.usage || {};
  return { input_tokens, output_tokens };
}

function parseTriage(response) {
  checkRefusal(response);
  const block = response.content.find((b) => b.type === "text");
  if (!block) throw new Error("Triage reply has no text block");
  return { plan: JSON.parse(block.text) };
}

function parseGenerate(response) {
  checkRefusal(response);
  return { text: response.content.filter((b) => b.type === "text").map((b) => b.text).join("") };
}

const STEPS = {
  triage: { parse: parseTriage, kind: "triage" },
  generate: { parse: parseGenerate, kind: "generate" },
  repair: { parse: parseGenerate, kind: "generate" },
};

function buildRequest(kind, { system, user }) {
  const messages = [{ role: "user", content: user }];
  if (kind === "triage") {
    return {
      model: HAIKU,
      max_tokens: 8000,
      output_config: { effort: "low", format: { type: "json_schema", schema: PLAN_SCHEMA } },
      system,
      messages,
    };
  }
  return {
    model: SONNET,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium" },
    system,
    messages,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createAiClient(opts) {
  const recorder = { calls: [] };
  let call;

  if (opts.mode === "live") {
    const client = new opts.Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true });
    call = async (step, prompt) => {
      const { kind } = STEPS[step];
      const request = buildRequest(kind, prompt);
      const t0 = Date.now();
      const response = kind === "triage"
        ? await client.messages.create(request)
        : await client.beta.messages.create(request);
      const ms = Date.now() - t0;
      const usage = usageOf(response);
      recorder.calls.push({
        step,
        request: { model: request.model, system: request.system, messages: request.messages },
        response,
        usage,
        ms,
      });
      return { response, usage, ms };
    };
  } else if (opts.mode === "replay") {
    const { recording, speed = 1 } = opts;
    let i = 0;
    call = async (step) => {
      const rec = recording.calls[i];
      if (!rec) throw new ReplayExhausted(`Recording has no call #${i + 1} (requested "${step}")`);
      if (rec.step !== step) throw new ReplayMismatch(`Recorded call #${i + 1} is "${rec.step}", but "${step}" was requested`);
      i++;
      if (speed !== Infinity && rec.ms > 0) await sleep(rec.ms / speed);
      return { response: rec.response, usage: usageOf(rec.response), ms: rec.ms };
    };
  } else {
    throw new Error(`Unknown AI client mode: ${opts.mode}`);
  }

  const run = (step) => async (prompt) => {
    const { response, usage, ms } = await call(step, prompt);
    return { ...STEPS[step].parse(response), usage, ms };
  };

  return { triage: run("triage"), generate: run("generate"), repair: run("repair"), recorder };
}
