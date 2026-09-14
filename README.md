# Repro: `workflow-<key>` tool trusts a model-supplied `suspendedToolRunId`

`@mastra/core@1.64.0`. Deterministic, no real LLM, no network, no API key.

## Run

```bash
npm install
npm run repro
```

Exits `0` and prints `✅ REPRODUCED` when the bug is present.

## What it shows

The auto-generated `workflow-<key>` delegation tool splices a **model-visible**
`suspendedToolRunId` field into its input schema, and in its `execute` uses that value
verbatim as the workflow run id:

```ts
// agent/agent.ts — listWorkflowTools workflow-tool execute
const runIdToUse = suspendedToolRunId || randomUUID();
const run = await workflow.createRun({ runId: runIdToUse, ... });
```

The `||` guard rejects `""` / `undefined` but **not** the truthy literal string `"null"`
that some models emit. So an ordinary (non-resume) tool call pins a constant, model-controlled
run id.

- **PART 1** drives a scripted mock `LanguageModelV2` that authors
  `suspendedToolRunId: "null"`. The repro wraps `workflow.createRun` and prints the run id the
  framework hands it: `"null"` — unvalidated model output used as a persistence key.
- **PART 2** shows the consequence with two independent approval-gated (suspended) calls that
  share `"null"`: they collapse onto **one** run instance, so one request is lost. Omitting the
  field (control) gives each call its own run. HITL (suspend-for-approval) is the trigger — a
  plain create/finish does not collide on this version.

## Expected output

```
PART 1 — run ids the framework handed workflow.createRun: ["null"]
PART 2 — BUG (shared 'null'): same run instance? true  | completed: ["B"]
         CONTROL (id omitted): same run instance? false | completed: ["A","B"]
✅ REPRODUCED.
```

## Agent-delegation variant (`npm run repro:agent`)

The same defect — an unsanitised model-supplied `suspendedToolRunId` on a
resumable tool — also affects the **agent-delegation** resume path
(`supervisor → agent-<name> → approval-gated tool`), via a different mechanism
and a different symptom. `suspendedToolRunId` is spliced into **every** resumable
tool's schema (`isResumableTool = toolName?.startsWith("agent-") ||
toolName?.startsWith("workflow-")`), not just workflow tools.

On the agent path the model's truthy `"null"` does not get _adopted_ — it
_blocks_ the framework's back-fill of the real sub-agent run id
(`delegatedRunId`), because the back-fill is guarded by
`!cleanedArgs.suspendedToolRunId`. The sub-agent is then resumed with
`runId: "null"`, misrouting to a non-existent run: nothing is written and the
delegation's `toModelOutput` crashes on the empty result
(`Cannot read properties of undefined (reading 'text')`).

`repro-agent-delegation.mjs` drives a durable supervisor → `agent-bookingAgent`
→ an approval-gated `reserve` tool, with a scripted mock model. BUG and CONTROL
differ only in the model-supplied `suspendedToolRunId`:

```
BUG     (model authored suspendedToolRunId:'null'):
  sub-agent RESUME runIds: ["null"]   | bookings written: []   -> toModelOutput crash
CONTROL (field omitted):
  sub-agent RESUME runIds: ["<real delegatedRunId>"] (back-filled) | bookings written: ["booking-Ada"]
✅ REPRODUCED.
```

See `REPORT-agent-delegation.md` for the full source trace (line-cited against
`@mastra/core@1.64.0`), the workflow-vs-agent diff, and fix options.

## Relation to existing issues

- **Closest prior art: #20322 / #20347.** #20322 (concurrent workflow-as-tool approvals resume the
  wrong suspended run) was fixed by #20347, which tracks suspended workflow tool calls **by
  `toolCallId`** and preserves each suspended run id — but that assumes each call has a **distinct**
  run id. This bug is its residual: a model-supplied `"null"` makes `createRun` build the runs with
  the **same** id, so they collide before per-`toolCallId` tracking can separate them. #20347's
  machinery is present in `@mastra/core@1.64.0`, yet this still reproduces there.
- Same `createRun` run-id-uniqueness line as #13473 / #13478. #13478 hardened the **fallback**
  (`|| randomUUID()`) so parallel calls _without_ the field get unique ids (the control here). It
  did **not** validate the model-supplied field, which this reproduces.
- Distinct from #20213 (the resume-drop direction — the delegated run id is _lost_ on resume).
  Here an independent call _adopts_ a foreign run id instead.

## Suggested fix

Sanitize `suspendedToolRunId` before use — treat the literal `"null"` / `"undefined"` (and any
non-uuid / non-`call_*` value) as absent so `|| randomUUID()` fires, or validate it against the
run registry, or stop exposing the raw run-id field to the model.
