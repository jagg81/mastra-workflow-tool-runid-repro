/**
 * Minimal, deterministic reproduction (no real LLM, no network, no API key) of
 * the AGENT-DELEGATION variant of the model-supplied `suspendedToolRunId` defect.
 *
 * Companion to repro.mjs (the workflow-tool variant). SAME root defect —
 * the framework trusts an unsanitised model-supplied `suspendedToolRunId` on a
 * resumable tool — but a DIFFERENT code path and a DIFFERENT symptom.
 *
 * DEFECT (agent delegation path, @mastra/core@1.64.0, read from dist)
 * ------------------------------------------------------------------
 * `suspendedToolRunId` is spliced into the input schema of EVERY resumable tool,
 * not just workflow tools:
 *     // create-durable-agent-*.js:4056
 *     const isResumableTool = toolName?.startsWith("agent-") || toolName?.startsWith("workflow-");
 *
 * On the INITIAL delegated call the sub-agent is started with NO runId, so its
 * inner run gets a framework-owned id (`delegatedRunId`); the suspend snapshot
 * stores it (agent-*.js:26265  `...{ delegatedRunId: suspendedToolRunId }`).
 *
 * On RESUME the durable layer BACK-FILLS that real id — but only if the model
 * left the field falsy:
 *     // create-durable-agent-*.js:4054/4059
 *     const cleanedArgs = { ...args };
 *     if ((isResumingFromSuspension || isDelegatedApprovalResume) && isResumableTool
 *          && !cleanedArgs.suspendedToolRunId && typeof suspendedToolRunId === "string")
 *       cleanedArgs.suspendedToolRunId = suspendedToolRunId;   // real delegatedRunId
 *
 * The literal string "null" is TRUTHY, so `!cleanedArgs.suspendedToolRunId` is
 * false and the back-fill is BLOCKED. The junk value is then used verbatim to
 * resume the sub-agent:
 *     // agent-*.js:35324/35326/35450
 *     const suspendedToolRunId = inputData.suspendedToolRunId;              // "null"
 *     const shouldResumeSubAgent = !!resumeData && !!suspendedToolRunId;    // true
 *     await resolvedAgent.resumeStream(resumeData, { runId: suspendedToolRunId, ... });
 *
 * `resumeStream({ runId: "null" })` misroutes to a non-existent run: the real
 * suspended reserve approval is never resumed, so the booking is never written,
 * and the delegation's toModelOutput dereferences the empty result:
 *     // agent-*.js:35100
 *     value: typeof output === "string" ? output : output.text ?? ""
 * -> `toModelOutput failed for tool "agent-bookingAgent": Cannot read properties
 *     of undefined (reading 'text')`.
 *
 * CONTRAST WITH THE WORKFLOW PATH
 * -------------------------------
 *   workflow: `runIdToUse = suspendedToolRunId || randomUUID()` -> junk ADOPTED
 *             as the run id -> two independent calls COLLIDE at createRun.
 *   agent:    back-fill guard `!cleanedArgs.suspendedToolRunId` -> junk BLOCKS
 *             the real delegatedRunId -> resume MISROUTES -> undefined-deref crash.
 *
 * WHAT THIS SCRIPT PROVES
 * -----------------------
 * A durable supervisor delegates to a booking sub-agent whose `reserve` tool
 * requires approval (the real POC shape). Two scenarios, model + transport held
 * constant, the ONLY difference being the model-supplied `suspendedToolRunId`:
 *   BUG     — model authors suspendedToolRunId:"null" on the agent-bookingAgent
 *             call. On approval-resume the sub-agent is resumed with runId="null",
 *             the reserve never executes, no booking is written.
 *   CONTROL — model omits the field. On approval-resume the framework back-fills
 *             the real delegatedRunId, the sub-agent resumes its suspended run,
 *             reserve executes, a booking is written.
 * The effective sub-agent resume runId is captured directly by wrapping the
 * sub-agent's resumeStream/resumeGenerate/stream.
 */
import { Agent } from "@mastra/core/agent";
import { createDurableAgent } from "@mastra/core/agent/durable";
import { createTool } from "@mastra/core/tools";
import { EventEmitterPubSub } from "@mastra/core/events";
import { InMemoryServerCache } from "@mastra/core/cache";
import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { simulateReadableStream } from "ai/test";
import { rmSync } from "node:fs";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Mock LanguageModelV2 helper. `script` is a list of turns; a "toolcall" turn
// emits one tool call, a "text" turn ends the run with text.
// ---------------------------------------------------------------------------
function makeMockModel(script) {
  let i = 0;
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const responseFor = (step) =>
    step?.kind === "toolcall"
      ? {
          content: [
            {
              type: "tool-call",
              toolCallId: step.toolCallId,
              toolName: step.toolName,
              input: JSON.stringify(step.input),
            },
          ],
          finishReason: "tool-calls",
          usage,
          warnings: [],
        }
      : {
          content: [{ type: "text", text: step?.text ?? "done" }],
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
      if (step?.kind === "toolcall") chunks.push({ ...r.content[0] });
      else
        chunks.push(
          { type: "text-start", id },
          { type: "text-delta", id, delta: r.content[0].text },
          { type: "text-end", id },
        );
      chunks.push({ type: "finish", finishReason: r.finishReason, usage });
      return { stream: simulateReadableStream({ chunks }) };
    },
  };
}

// Callback-driven driver: the durable agent stream stays OPEN across a suspend,
// so we settle on whichever of onSuspended/onFinish/onError fires first.
function driver() {
  let settled = false;
  let resolve;
  const done = new Promise((r) => (resolve = r));
  const state = { suspend: null, err: null, finished: false };
  const settle = (fn) => {
    if (settled) return;
    settled = true;
    fn();
    resolve();
  };
  return {
    done,
    state,
    callbacks: {
      onSuspended: (d) =>
        settle(
          () => (state.suspend = { toolCallId: d.toolCallId, args: d.args }),
        ),
      onFinish: () => settle(() => (state.finished = true)),
      onError: ({ error }) =>
        settle(
          () =>
            (state.err =
              error instanceof Error ? error.message : String(error)),
        ),
    },
  };
}

// ---------------------------------------------------------------------------
// One scenario: durable supervisor -> agent-bookingAgent -> reserve (approval).
// `injectNull` decides whether the supervisor model authors
// suspendedToolRunId:"null" on the delegated call.
// ---------------------------------------------------------------------------
async function runScenario({ injectNull, dbName }) {
  // Observables.
  const reserved = []; // booking rows the reserve tool actually wrote
  const subAgentResumeRunIds = []; // runId used to resume the sub-agent
  const subAgentStartRunIds = []; // runId the sub-agent's initial stream used

  // --- sub-agent (booking specialist) ---------------------------------------
  const reserve = createTool({
    id: "reserve",
    description: "Reserve the appointment. Requires human approval.",
    requireApproval: true,
    inputSchema: z.object({ client: z.string() }),
    outputSchema: z.object({ bookingId: z.string() }),
    execute: async ({ client }) => {
      const bookingId = "booking-" + client;
      reserved.push(bookingId);
      return { bookingId };
    },
  });

  const bookingAgent = new Agent({
    name: "bookingAgent",
    instructions: "Call reserve to book, then confirm.",
    model: makeMockModel([
      {
        kind: "toolcall",
        toolCallId: "reserve-1",
        toolName: "reserve",
        input: { client: "Ada" },
      },
      { kind: "text", text: "Booked." },
    ]),
    tools: { reserve },
  });

  // Instrument the sub-agent's resume/stream entry points to capture the
  // effective runId the framework keys the sub-agent run on.
  const wrap = (name, sink) => {
    const orig = bookingAgent[name]?.bind(bookingAgent);
    if (!orig) return;
    bookingAgent[name] = async (...a) => {
      const opts = a[a.length - 1];
      sink.push(opts?.runId);
      return orig(...a);
    };
  };
  wrap("resumeStream", subAgentResumeRunIds);
  wrap("resumeGenerate", subAgentResumeRunIds);
  wrap("stream", subAgentStartRunIds);

  // --- supervisor -----------------------------------------------------------
  const delegatedInput = injectNull
    ? { prompt: "book Ada", suspendedToolRunId: "null" }
    : { prompt: "book Ada" };

  const supervisorBase = new Agent({
    name: "supervisor",
    instructions: "Delegate booking to agent-bookingAgent.",
    model: makeMockModel([
      {
        kind: "toolcall",
        toolCallId: "deleg-1",
        toolName: "agent-bookingAgent",
        input: delegatedInput,
      },
      { kind: "text", text: "Done." },
    ]),
    agents: { bookingAgent },
  });

  const supervisor = createDurableAgent({
    agent: supervisorBase,
    cache: new InMemoryServerCache(),
    pubsub: new EventEmitterPubSub(),
  });

  const mastra = new Mastra({
    agents: { supervisor },
    storage: new LibSQLStore({ id: "agentdeleg", url: `file:./${dbName}` }),
    cache: new InMemoryServerCache(),
    pubsub: new EventEmitterPubSub(),
  });
  await mastra.getStorage().init();
  await mastra.startWorkers();
  const a = mastra.getAgent("supervisor");

  // Phase 1: stream to the reserve approval suspend.
  const d1 = driver();
  const s1 = await a.stream("book Ada", {
    threadId: "t1",
    resourceId: "r1",
    ...d1.callbacks,
  });
  await d1.done;
  const runId = s1.runId;

  // Phase 2: approve. This re-enters agent-bookingAgent, which resumes the
  // suspended sub-agent run — with the back-filled real id (control) or the
  // model's junk "null" (bug).
  const d2 = driver();
  let resumeError = null;
  try {
    await a.resume(
      runId,
      { approved: true },
      {
        toolCallId: d1.state.suspend?.toolCallId ?? "deleg-1",
        ...d2.callbacks,
      },
    );
    await d2.done;
  } catch (e) {
    resumeError = e.message;
  }

  return {
    reserved,
    subAgentStartRunIds,
    subAgentResumeRunIds,
    resumeError: resumeError ?? d2.state.err,
    suspendToolCallId: d1.state.suspend?.toolCallId ?? null,
  };
}

// ---------------------------------------------------------------------------
for (const f of [".repro-agentdeleg-bug.db", ".repro-agentdeleg-control.db"]) {
  try {
    rmSync(f, { force: true });
    rmSync(f + "-shm", { force: true });
    rmSync(f + "-wal", { force: true });
  } catch {}
}

const bug = await runScenario({
  injectNull: true,
  dbName: ".repro-agentdeleg-bug.db",
});
const control = await runScenario({
  injectNull: false,
  dbName: ".repro-agentdeleg-control.db",
});

console.log("\n===================== RESULTS =====================");
console.log("BUG     (model authored suspendedToolRunId:'null'):");
console.log(
  "  sub-agent initial-stream runIds:",
  JSON.stringify(bug.subAgentStartRunIds),
);
console.log(
  "  sub-agent RESUME runIds:        ",
  JSON.stringify(bug.subAgentResumeRunIds),
);
console.log("  bookings written:               ", JSON.stringify(bug.reserved));
console.log("  resume error:                   ", bug.resumeError ?? "(none)");
console.log("CONTROL (field omitted):");
console.log(
  "  sub-agent initial-stream runIds:",
  JSON.stringify(control.subAgentStartRunIds),
);
console.log(
  "  sub-agent RESUME runIds:        ",
  JSON.stringify(control.subAgentResumeRunIds),
);
console.log(
  "  bookings written:               ",
  JSON.stringify(control.reserved),
);
console.log(
  "  resume error:                   ",
  control.resumeError ?? "(none)",
);
console.log("===================================================\n");

// BUG: sub-agent resumed with the literal "null" (back-fill blocked); no booking.
const bugMisrouted =
  bug.subAgentResumeRunIds.includes("null") || bug.reserved.length === 0;
// CONTROL: sub-agent resumed with a real (non-"null") id; booking written.
const controlHealthy =
  control.reserved.length === 1 &&
  !control.subAgentResumeRunIds.includes("null");

if (bugMisrouted && controlHealthy) {
  console.log(
    "✅ REPRODUCED.\n" +
      "   BUG: the model's literal 'null' blocked the real-delegatedRunId back-fill;\n" +
      "        the sub-agent resume misrouted (runId='null') and no booking was written.\n" +
      "   CONTROL: with the field omitted the framework back-filled the real inner\n" +
      "        run id, the sub-agent resumed its suspended reserve, and a booking was\n" +
      "        written. The unvalidated model-supplied suspendedToolRunId is the sole\n" +
      "        difference — same defect class as the workflow path (repro.mjs), via the\n" +
      "        agent-delegation back-fill guard.",
  );
  process.exit(0);
}

console.log("❌ NOT REPRODUCED as expected.");
console.log(
  "   bugMisrouted:",
  bugMisrouted,
  "| controlHealthy:",
  controlHealthy,
);
process.exit(1);
