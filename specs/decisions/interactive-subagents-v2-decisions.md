# Feature: interactive-subagents-v2 — Decisions

## Feature Boundary

v2 enriches parent ↔ child coordination beyond v1's "launch + done signal + summary" with three additive capabilities, all aligned with pi-interactive-subagents' patterns adapted for Copilot CLI's per-process pane-backed model:

1. **Structured exit sidecar** — replace v1's write-only signal file with a JSON `.exit` sidecar carrying type, summary, message, exit code, version, and forensic metadata.
2. **`caller_ping`** — exit-with-status tool that lets a child request help from the parent. The child writes a `.exit` sidecar and returns a tool result instructing the model to end its turn; the child terminates only when the model finishes its turn and `copilot -p` exits naturally. Parent's blocking launch tool resolves with the ping payload.
3. **Tool access control** — strip all five public spawning tools from child sessions so only the top-level session can orchestrate.

The launch model remains synchronous/blocking (parent's launch tool call polls until child terminates). Async injection, mailbox queues, and user-takeover detection are explicitly out of scope.

## Decisions (locked)

- **Sidecar file strategy** → **A. Replace** `high` — Drop the v1 signal file (`<stateDir>/done/<copilotSessionId>`) entirely. v1 file is write-only-and-never-read; no consumers exist. v2 introduces `<stateDir>/exit/<launchId>.json` as the single explicit-done breadcrumb. Resume cleanup is updated to delete the new path.

- **Sidecar schema** → **B. Richer** `high` — `{version: 1, type: "done"|"ping", writtenAt: ISO8601, launchId: string, summary?: string, message?: string, exitCode?: number}`. Version field enables future schema evolution; writtenAt + launchId aid forensic diagnosis. Exit code remains primarily sourced from pane sentinel; sidecar `exitCode` is informational only.

- **`caller_ping` return shape** → **A. Augmented success** `high` — Parent's `copilot_subagent_launch`/`_resume` resolves with `{status: "ping", launchId, sessionId, ping: {message}, paneId, summary: null, exitCode: 0, ...existing fields}`. Adds `"ping"` to the existing status taxonomy (does NOT replace `"success"`). Parent agent inspects `status` field. `summary` is **always `null`** (never omitted) when `status === "ping"`.

- **Launch model** → **A. Blocking (pi-style)** `high` — Launch tool call does not return until child writes a sidecar (done OR ping) or hits pane sentinel. No new async/wait/status tools. Matches v1 behavior; matches pi.

- **Resume-after-ping context** → **A. Parent's `task` only (extend `copilot_subagent_resume` schema with optional `task` field)** `high` — Resume signature is **launch-id based** (NOT sessionId-based). Current schema (`lib/tool-schemas.mjs:171-196`) accepts `{launchId|resumeReference|resumePointer, awaitCompletion}` only — there is no field to carry a parent response. v2 **adds** an optional `task: string` field. When provided, the resumed child receives `task` as its launch prompt (same delivery path as initial launch); when omitted, behavior is unchanged from v1 (resume original session as-is). Extension does not auto-prepend the prior ping message — parent agent crafts `task` itself, including any echo of the ping context it wants. This is the only schema change to `copilot_subagent_resume` in v2.

- **Spawning tools to strip from children** → **A. Strip all 5 public tools (both snake_case and camelCase aliases)** `high` — When the child marker env var is set at extension load, exclude these from `tools[]` passed to `joinSession`: `copilot_subagent_launch`, `copilot_subagent_parallel`, `copilot_subagent_resume`, `copilot_subagent_set_title`, `copilot_subagent_list_agents`, AND their camelCase aliases (`copilotSubagentLaunch`, `copilotSubagentParallel`, `copilotSubagentResume`, `copilotSubagentSetTitle`, `copilotSubagentListAgents`) defined in `lib/tool-schemas.mjs:218-223`. Children retain `subagent_done` + `caller_ping`. Invariant: only the top-level session orchestrates.

- **Child marker env var** → **`COPILOT_SUBAGENT_LAUNCH_ID`** `high` — Use `LAUNCH_ID` (not `SESSION_ID`) as the gating predicate. `COPILOT_SUBAGENT_LAUNCH_ID` is set unconditionally by `lib/backend-ops.mjs:244-246` for every backend (cmux, tmux, zellij), whereas `COPILOT_SUBAGENT_SESSION_ID` is intentionally null for cmux launches (`lib/launch.mjs:364`). Same security properties; works across all backends without changing cmux launch wiring.

- **Manifest versioning** → **B. Hard cutover to v3** `high` — User confirmed package was never published; only personal use. v3 manifests only after upgrade. New fields: `pingHistory: Array<{message: string, sentAt: ISO8601, respondedAt?: ISO8601}>`, `lastExitType: "done"|"ping"|null`, `sidecarPath: string`. `readLaunchRecord` (single layer) rejects manifests where `metadataVersion !== 3` with `MANIFEST_VERSION_UNSUPPORTED`. Resume propagates the error. No dual-read.

- **Child shutdown mechanism** → **Best-effort: tool returns + assistant turn ends + `copilot -p` exits + wrapper sentinel** `high` — Copilot CLI tool handlers have NO `ctx.shutdown()` equivalent (unlike pi). The child terminates only when its model finishes its assistant turn, after which `copilot -p "<task>"` exits naturally and the wrapper script emits `__SUBAGENT_DONE_<exitCode>__`. `caller_ping`/`subagent_done` therefore: (1) write the sidecar synchronously, (2) return a tool result with explicit instruction "Session is terminating. Do not call further tools. End your turn." This is best-effort — a misbehaving model could call additional tools, each rewriting the sidecar (no file lock). Mitigations: (a) parent's per-tick `readExitSidecar` is the atomic snapshot — the **first sidecar contents observed by the parent's poll** wins (not the first write to the file); (b) parent's poll loop stops watching once sidecar appears; (c) sentinel arrival is still required to release the pane. We accept this gap; documenting it is the deliverable.

- **Launch-result status taxonomy** → **Existing values + new `"ping"`** `high` — Code currently uses `success | failure | timeout | cancelled | pending | running` (verified in `lib/launch.mjs` and `lib/progress.mjs`). v2 adds **one** new value: `"ping"`. No rename of existing values. Parallel aggregation in `lib/progress.mjs` treats `"ping"` as a non-failure outcome (counted alongside `"success"` for "completed-without-error" totals); `pingCount` is exposed as a separate aggregate. Spec text must NOT use `"complete"` or `"failed"` (those are not real status values).

- **Sidecar vs sentinel poll precedence** → **Sidecar checked first every tick; sidecar wins** `high` — Each poll tick: (1) call `readExitSidecar(launchId)`; if it returns non-null, finalize result from sidecar (sentinel arrival is now optional, just used to release the pane). (2) Otherwise check pane buffer for sentinel; if found, perform ONE final `readExitSidecar` re-read (to capture late writes that landed after the previous tick), then if still null fall back to v1 pane-scrape summary. (3) Otherwise continue polling. This makes "child wrote sidecar before sentinel" the dominant case (sidecar is the explicit authority).

## Agent Discretion

- **Exact file naming inside `<stateDir>/exit/`**: `<launchId>.json` is the canonical pattern; if collision with reserved characters arises, a sanitization step may be added.
- **Atomicity**: `tmp + rename()` is recommended for the sidecar write to keep each individual write atomic. Bare `writeFileSync` is acceptable as a fallback. Note: a misbehaving model can call `caller_ping` and `subagent_done` in the same turn, so writes are not guaranteed to be one-shot — the parent's per-tick `readExitSidecar` snapshot is the atomicity boundary that matters.
- **Error wording**: Tool descriptions and error messages may be refined for LLM clarity during implementation.
- **Test file organization**: Per repo conventions, new v2 unit tests go under `test/unit/`; integration coverage may extend `test/integration/`.

## Deferred Ideas (NOT in scope)

- **Async parent ↔ child channel** — background watcher injecting messages into a still-running parent. Requires `session.send({mode:"enqueue"})` which: (a) cannot tag injected messages as non-user (no `source` field in `MessageOptions`); (b) pollutes parent conversation history as fake user turns; (c) the watcher's `setInterval` dies on `/clear`/reload. Not justified by current use cases; pi explicitly avoids this too.
- **User-takeover detection** — depends on distinguishing real user input from extension-injected via `user.message.source`, which extensions cannot set. Moot without async injection.
- **Non-blocking launch / `_status` / `_wait` tools** — significantly larger redesign; possible v3 topic.
- **Per-launch `denyTools` parameter / config UI** — beyond recursion prevention, broader sandboxing belongs to a separate effort using SDK-level `availableTools`/`excludedTools`.
- **CLI-level `availableTools`/`excludedTools` filtering** — sandboxing of built-in tools (`bash`, `view`, etc.) is deferred.
- **Artifact system** — Copilot CLI agents have full filesystem access via `view`/`edit`/`create`/`bash`; pi's artifact system is redundant here.
- **Live progress widget** — requires SDK `sendMessage`-equivalent; not available.
- **Auto-exit lifecycle hooks** — pi's `agent_end`/`input` events have no Copilot SDK equivalent. Our explicit `subagent_done` already covers the autonomous-completion path.
- **Pane-script command delivery** (line-wrap-safe execution via temp `.sh` file) — separate cleanup, not v2-gated.
