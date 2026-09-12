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
