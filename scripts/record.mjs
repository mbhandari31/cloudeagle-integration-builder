// Records one real Calendly run against the live Claude API into recordings/calendly.json.
// The key comes only from ANTHROPIC_API_KEY and is never written to disk.
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAiClient } from "../src/ai/client.js";
import { runPipeline } from "../src/pipeline.js";
import { runInNode } from "../src/sandbox/runNode.js";

const SPEC_URL = "https://developer.calendly.com/openapi/calendly-api.yaml"; // shown in the page
// The run is recorded against the committed snapshot, which is also what replay reads.
const SPEC_SOURCE = "fixtures/calendly-api.yaml";
const SPEC_PATH = fileURLToPath(new URL(`../${SPEC_SOURCE}`, import.meta.url));
const WANTS = ["users", "usage"];
const MODELS = { triage: "claude-haiku-5-5", generate: "claude-sonnet-5-5" };
const DEFAULT_OUT = fileURLToPath(new URL("../recordings/calendly.json", import.meta.url));

export async function record({
  apiKey, Anthropic: AnthropicClass = Anthropic, now = new Date(),
  outPath = DEFAULT_OUT, specUrl = SPEC_URL, specPath = SPEC_PATH, log = console.log,
}) {
  const specText = await readFile(specPath, "utf8");
  const specSha256 = createHash("sha256").update(specText, "utf8").digest("hex");
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => specText });
  const ai = createAiClient({ mode: "live", apiKey, Anthropic: AnthropicClass });
  const result = await runPipeline(
    { specUrl, wants: WANTS, ai, runner: runInNode, now, fetchImpl },
    (e) => {
      if (e.type === "stage") log(`[${e.stage}] ${e.status} — ${e.detail ?? ""}`);
      else if (e.type === "attempt") log(`attempt ${e.n}`);
    },
  );

  // Keep only model/system/messages from each request (client.js already does; enforced here too).
  const calls = ai.recorder.calls.map((c) => ({
    ...c,
    request: { model: c.request.model, system: c.request.system, messages: c.request.messages },
  }));
  const recording = {
    recordedAt: now.toISOString(),
    specUrl,
    specSource: SPEC_SOURCE,
    specSha256,
    models: MODELS,
    calls,
    result: {
      status: result.status,
      attempts: result.attempts,
      usage: result.usage,
      stats: result.validation?.stats ?? null,
      finalCode: result.code,
    },
  };
  const json = JSON.stringify(recording, null, 2);
  if ((apiKey && json.includes(apiKey)) || json.includes("sk-" + "ant")) {
    throw new Error("Refusing to write the recording: it contains something that looks like an API key");
  }
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, json + "\n");

  const s = result.validation?.stats;
  log(`Wrote ${outPath}`);
  log(`${result.status}, ${result.attempts} attempts, users ${s?.users ?? "n/a"}, inactive ${s?.inactive90d ?? "n/a"}, tokens ${result.usage.inputTokens}/${result.usage.outputTokens}`);
  return { result, recording, outPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Set ANTHROPIC_API_KEY in your shell to record a run (the key is never written to disk).");
    process.exit(1);
  }
  try {
    const { result } = await record({ apiKey });
    process.exit(result.status === "passed" ? 0 : 2);
  } catch (e) {
    console.error(`Recording failed: ${e.message}`);
    process.exit(3);
  }
}
