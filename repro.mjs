/**
 * Minimal, deterministic reproduction (no real LLM, no network, no API key).
 *
 * DEFECT
 * ------
 * The framework auto-generates a `workflow-<key>` delegation tool and splices a
 * model-visible `suspendedToolRunId` field into its input schema. In the tool's
 * execute it uses that value verbatim as the workflow run id:
 *
 *     const runIdToUse = suspendedToolRunId || randomUUID();     // agent/agent.ts
 *     const run = await workflow.createRun({ runId: runIdToUse, ... });
 *
 * The `||` guard rejects "" / undefined but NOT the truthy literal string
 * "null" that some models emit. So the run id becomes the constant "null"
 * across independent (non-resume) tool calls — a model-controlled, unvalidated
 * persistence key. (Hardening #13478 fixed the *fallback* to randomUUID; it did
 * not validate the model-supplied field, which this reproduces.)
 *
 * This script proves two things:
 *   PART 1 — the framework hands createRun the literal "null" from model output.
 *   PART 2 — two INDEPENDENT approval-gated (suspended) calls that share the
 *            "null" run id collide onto ONE run: the second reuses the first's
 *            suspended run, so one request is lost. Omitting the field (control)
 *            gives each call its own run.
 *
 * PART 2 is at the workflow layer on purpose: it is the exact `createRun(runId)`
 * the tool performs in PART 1, without the LLM. HITL (suspend-for-approval) is
 * the trigger — a plain create/finish does not collide on this version.
 */
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core";
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { LibSQLStore } from "@mastra/libsql";
import { simulateReadableStream } from "ai/test";
import { rmSync } from "node:fs";
import { z } from "zod";

// A workflow that suspends for approval before executing (the HITL shape), and
// records which inputs actually run.
function makeWorkflow(executed) {
  const gate = createStep({
    id: "gate",
    inputSchema: z.object({ message: z.string() }),
    resumeSchema: z.object({ approve: z.boolean() }),
    suspendSchema: z.object({ ask: z.string() }),
    outputSchema: z.object({ echoed: z.string() }),
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!resumeData)
        return await suspend({ ask: `approve ${inputData.message}?` });
      executed.push(inputData.message);
      return { echoed: inputData.message };
    },
  });
  return createWorkflow({
    id: "echoWorkflow",
    inputSchema: z.object({ message: z.string() }),
    outputSchema: z.object({ echoed: z.string() }),
  })
    .then(gate)
    .commit();
}

// ---------------------------------------------------------------------------
// PART 1 — the framework passes a model-supplied "null" verbatim to createRun.
// ---------------------------------------------------------------------------
// Scripted mock LanguageModelV2: turn 1 calls workflow-echoWorkflow with the
// model authoring suspendedToolRunId:"null"; turn 2 ends with text.
function makeMockModel() {
  let i = 0;
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const script = [
    {
      kind: "toolcall",
      input: { inputData: { message: "A" }, suspendedToolRunId: "null" },
    },
    { kind: "text" },
  ];
  const responseFor = (step) =>
    step.kind === "toolcall"
      ? {
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "workflow-echoWorkflow",
              input: JSON.stringify(step.input),
            },
          ],
          finishReason: "tool-calls",
          usage,
          warnings: [],
        }
      : {
          content: [{ type: "text", text: "done" }],
          finishReason: "stop",
          usage,
          warnings: [],
        };
  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId: "mock-model",
    supportedUrls: {},
    doGenerate: async () => responseFor(script[i++] ?? { kind: "text" }),
    doStream: async () => {
      const step = script[i++] ?? { kind: "text" };
      const r = responseFor(step);
      const id = "t" + i;
      const chunks = [{ type: "stream-start", warnings: [] }];
      if (step.kind === "toolcall") chunks.push({ ...r.content[0] });
      else
        chunks.push(
          { type: "text-start", id },
          { type: "text-delta", id, delta: "done" },
          { type: "text-end", id },
        );
      chunks.push({ type: "finish", finishReason: r.finishReason, usage });
      return { stream: simulateReadableStream({ chunks }) };
    },
  };
}

async function part1_frameworkPassesNull() {
  const executed = [];
  const echoWorkflow = makeWorkflow(executed);
  const seenRunIds = [];
  const origCreateRun = echoWorkflow.createRun.bind(echoWorkflow);
  echoWorkflow.createRun = async (opts) => {
    seenRunIds.push(opts?.runId);
    return origCreateRun(opts);
  };

  const agent = new Agent({
    name: "echoAgent",
    instructions: "Call workflow-echoWorkflow when asked.",
    model: makeMockModel(),
    workflows: { echoWorkflow },
  });
  const mastra = new Mastra({
    agents: { echoAgent: agent },
    workflows: { echoWorkflow },
    storage: new LibSQLStore({ id: "part1", url: "file:./.repro-part1.db" }),
  });
  await mastra.getStorage().init();
  await mastra.getAgent("echoAgent").generate("add service A", { maxSteps: 3 });

  return seenRunIds;
}

// ---------------------------------------------------------------------------
// PART 2 — a shared "null" run id collides two independent suspended calls.
// ---------------------------------------------------------------------------
async function part2_runScenario(injectNull, dbName) {
  const executed = [];
  const echoWorkflow = makeWorkflow(executed);
  const mastra = new Mastra({
    workflows: { echoWorkflow },
    storage: new LibSQLStore({ id: "part2", url: `file:./${dbName}` }),
  });
  await mastra.getStorage().init();
  const wf = mastra.getWorkflow("echoWorkflow");

  const runId = () => (injectNull ? { runId: "null" } : {});

  // Two INDEPENDENT requests. Each suspends for its own approval.
  const rA = await wf.createRun(runId());
  await rA.start({ inputData: { message: "A" } });
  const rB = await wf.createRun(runId());
  await rB.start({ inputData: { message: "B" } });

  // Approve each. Independent runs each complete with their own input.
  const okA = await rA
    .resume({ resumeData: { approve: true } })
    .catch((e) => ({ error: e.message }));
  const okB = await rB
    .resume({ resumeData: { approve: true } })
    .catch((e) => ({ error: e.message }));

  return {
    sameInstance: rA === rB,
    executed,
    okA: okA?.result ?? okA,
    okB: okB?.result ?? okB,
  };
}

// ---------------------------------------------------------------------------
for (const f of [
  ".repro-part1.db",
  ".repro-part2-bug.db",
  ".repro-part2-control.db",
]) {
  try {
    rmSync(f, { force: true });
  } catch {}
}

const seenRunIds = await part1_frameworkPassesNull();
const bug = await part2_runScenario(true, ".repro-part2-bug.db");
const control = await part2_runScenario(false, ".repro-part2-control.db");

console.log("\n===================== RESULTS =====================");
console.log("PART 1 — run ids the framework handed workflow.createRun:");
console.log(
  "   ",
  JSON.stringify(seenRunIds),
  "  (model authored suspendedToolRunId:'null')",
);
console.log("PART 2 — two independent approval-gated calls (A, B):");
console.log(
  "  BUG     (shared 'null'): same run instance? ",
  bug.sameInstance,
  "| completed:",
  JSON.stringify(bug.executed),
);
console.log(
  "  CONTROL (id omitted):    same run instance? ",
  control.sameInstance,
  "| completed:",
  JSON.stringify(control.executed),
);
console.log("===================================================\n");

const part1Ok = seenRunIds.includes("null");
const bugReproduced = bug.sameInstance === true && bug.executed.length === 1;
const controlHealthy =
  control.sameInstance === false && control.executed.length === 2;

if (part1Ok && bugReproduced && controlHealthy) {
  console.log(
    "✅ REPRODUCED.\n" +
      "   PART 1: the framework passed the model's literal 'null' to createRun,\n" +
      "           unvalidated (it should never adopt a model-supplied run id).\n" +
      "   PART 2: two independent suspended calls sharing 'null' collapsed onto ONE\n" +
      "           run — a request was lost. Omitting the field gives each its own run,\n" +
      "           so the defect is the unvalidated model-supplied id (not #13478's\n" +
      "           randomUUID fallback, which still works).",
  );
  process.exit(0);
}

console.log("❌ NOT REPRODUCED as expected.");
console.log(
  "   part1Ok:",
  part1Ok,
  "| bugReproduced:",
  bugReproduced,
  "| controlHealthy:",
  controlHealthy,
);
process.exit(1);
