# Report: agent-delegation resume trusts a model-supplied `suspendedToolRunId`

`@mastra/core@1.64.0`. Companion to the workflow-tool defect (`repro.mjs` /
`README.md`). **Same root defect — the framework trusts an unsanitised
model-supplied `suspendedToolRunId` on a resumable tool — but a different code
path and a different symptom.** Deterministic repro: `npm run repro:agent`.

## Summary

A durable supervisor delegates a HITL task to a sub-agent (`agent-<name>` tool).
The sub-agent suspends on an approval-gated tool. On approval-resume the
framework must resume the sub-agent's own inner run, whose id it owns
(`delegatedRunId`). If the model authored a truthy-junk `suspendedToolRunId`
(the literal string `"null"`, which some models emit), the resume misroutes to a
non-existent run: the suspended work is never resumed, nothing is written, and
the delegation's `toModelOutput` crashes dereferencing the empty result:

```
toModelOutput failed for tool "agent-bookingAgent": TypeError: Cannot read properties of undefined (reading 'text')
```

## Root cause (read directly from `@mastra/core@1.64.0` dist)

1. `suspendedToolRunId` is spliced into the input schema of **every** resumable
   tool, agent delegations included — not just workflow tools:
   ```js
   // create-durable-agent-*.js:4056
   const isResumableTool =
     toolName?.startsWith("agent-") || toolName?.startsWith("workflow-");
   // utils-*.js:185/194 — the same predicate gates the suspendedToolRunId schema splice
   ```
2. Initial delegated call: the sub-agent is started with **no** runId
   (`agent-*.js:35461 resolvedAgent.stream(messagesForSubAgent, {...})`), so its
   inner run gets a framework-owned id. The suspend snapshot stores it:
   ```js
   // agent-*.js:26265
   ...suspendedToolRunId && suspendedToolRunId !== runId ? { delegatedRunId: suspendedToolRunId } : {}
   ```
   and resume reads it back (`agent-*.js:26612 entry.delegatedRunId ?? entry.runId`).
3. Resume back-fill — restores the real id, but **only if the model left the
   field falsy**:
   ```js
   // create-durable-agent-*.js:4054/4057/4059
   const cleanedArgs = { ...args }; // keeps model's "null"
   const suspendedToolRunId = suspendData?.suspendedToolRunId; // the real delegatedRunId
   if (
     (isResumingFromSuspension || isDelegatedApprovalResume) &&
     isResumableTool &&
     !cleanedArgs.suspendedToolRunId &&
     typeof suspendedToolRunId === "string"
   )
     cleanedArgs.suspendedToolRunId = suspendedToolRunId;
   ```
   `"null"` is truthy, so `!cleanedArgs.suspendedToolRunId` is false → **back-fill
   blocked**, the real id lost.
4. The junk value is then used verbatim to resume the sub-agent:
   ```js
   // agent-*.js:35324/35326/35450-35451
   const suspendedToolRunId = inputData.suspendedToolRunId;            // "null"
   const shouldResumeSubAgent = !!resumeData && !!suspendedToolRunId;  // true
   await resolvedAgent.resumeStream(resumeData, { runId: suspendedToolRunId, ... });
   ```
5. `resumeStream({ runId: "null" })` misroutes; the delegation result is empty and
   `toModelOutput` dereferences it:
   ```js
   // agent-*.js:35100
   value: typeof output === "string" ? output : (output.text ?? ""); // output undefined -> throws
   ```

## Diff vs the workflow-tool defect (`README.md`)

|                    | Workflow tool (`workflow-<key>`)                                                                                           | Agent delegation (`agent-<name>`)                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Where junk is used | `runIdToUse = suspendedToolRunId \|\| randomUUID()` — **adopted** as the run id                                            | back-fill guard `!cleanedArgs.suspendedToolRunId` — junk **blocks** the real `delegatedRunId` |
| Symptom            | two independent calls **collide** at `createRun`; one request lost                                                         | resume **misroutes** to a dead run; `toModelOutput` undefined-deref crash; nothing written    |
| Shared cause       | model-supplied literal `"null"` in the injected `suspendedToolRunId`, on tools the same `isResumableTool` predicate covers | same                                                                                          |

## Deterministic reproduction (`repro-agent-delegation.mjs`, no LLM / no network)

Durable supervisor → `agent-bookingAgent` → `reserve` (`requireApproval: true`).
Two scenarios, mock model + transport held constant, differing **only** in the
model-supplied `suspendedToolRunId`:

```
BUG     (model authored suspendedToolRunId:'null'):
  sub-agent RESUME runIds: ["null"]
  bookings written:        []
  [DurableAgent] toModelOutput failed for tool "agent-bookingAgent": TypeError: Cannot read properties of undefined (reading 'text')
CONTROL (field omitted):
  sub-agent RESUME runIds: ["1b45b30d-4317-4ce1-a291-3d49d4c6f0b0"]   (the real delegatedRunId, back-filled)
  bookings written:        ["booking-Ada"]
✅ REPRODUCED.
```

The run-id **value** is isolated as the sole cause, and the repro emits the
byte-exact production error string.

## Empirical corroboration (live drive, from the design/eval track — cross-reference, not re-verified here)

- **gpt-oss:120b-cloud, clean:** initial suspend emits JSON `null` (falsy) →
  back-fill fires → resume keys the real inner runId → booking written. Proves
  back-fill works on a falsy value.
- **gpt-oss, forced junk (control on model + transport):** hook forces
  `suspendedToolRunId="null"` on the agent-* resume → same `toModelOutput ...
reading 'text'`, no booking. Isolates the value live.
- **GLM-5.2, live:** emits the truthy literal `"null"` on `agent-bookingAgent`
  (as it does on workflow tools) → back-fill blocked → same crash, no booking.

## Fix options

Labelled by grounding — only the upstream sanitize is a same-place fix for both paths.

- **Upstream (cleanest):** sanitise/reject a non-uuid model-supplied
  `suspendedToolRunId` at the injected-field boundary (where `isResumableTool`
  applies). _Grounded inference — not yet tested:_ both the workflow and agent
  paths read the field from the same `isResumableTool` splice, so one boundary
  fix should close both. The repro here could be extended to assert a candidate
  fix (it is not, yet).
- **Consumer-side (untested hypothesis):** strip `suspendedToolRunId:"null"` from
  the model's tool call **before** the framework records it — a model-output
  middleware (`wrapLanguageModel`) post-processing generated tool calls — so the
  recorded arg is falsy and the existing back-fill fires. A `beforeToolCall`
  tool-hook analog (the workflow-path pin) does **not** work here: (a) the agent
  path needs the framework's `delegatedRunId`, not the `toolCallId`; (b) on resume
  the durable back-fill runs before `beforeToolCall`, and the replayed args still
  carry the raw `"null"`. (Live-tested and reverted in the consumer track; not
  re-verified in this repo.)
- **Structural (consumer-side):** re-home the delegated HITL work as a workflow
  under the supervisor so the workflow-tool `toolCallId` pin covers it.

## Same issue vs separate

Same root defect, different manifestation, and a workflow-only fix leaves the
agent path broken (proven by the control here). **Recommend broadening #23739**
from "the workflow-tool wrapper trusts a model-supplied run id" to "**resumable
tools (workflow AND agent-delegation) trust an unsanitised model-supplied
`suspendedToolRunId`**". If #23739 is already closed/merged with a workflow-only
fix and will not reopen scope, file a separate linked issue.

## Provenance

| Claim                                                   | How verified                                                                                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Source mechanism (steps 1–5)                            | Read from `node_modules/@mastra/core@1.64.0` dist at the cited lines                                                                   |
| Bug vs control run-id + crash + no-write                | Deterministic no-LLM repro `repro-agent-delegation.mjs`                                                                                |
| Live model behaviour (gpt-oss clean/forced, GLM "null") | Live drive in the design/eval track — cross-referenced, not re-run here                                                                |
| Fix viability                                           | Upstream = grounded inference (untested); consumer tool-hook = live-tested and reverted; model-output middleware = untested hypothesis |
