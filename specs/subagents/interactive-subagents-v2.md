# Interactive Subagents v2

Structured exit sidecar, `caller_ping` exit-with-status, and child-tool access control.

## Traceability

- **Shared Key**: interactive-subagents-v2
- **Spec Path**: specs/subagents/interactive-subagents-v2.md
- **Requirement Refs**: None
- **Decision Refs**: specs/decisions/interactive-subagents-v2-decisions.md
- **Predecessor**: specs/subagents/interactive-subagents-v1.md

## Start Here

> **Read this section first. Use the "Code Map" and "What to Build" tables to find your component.**

> ⚠️ **Override of `AGENTS.md`:** AGENTS.md points at `specs/subagents/interactive-subagents-v1.md` as "implementation source of truth." For this story, **ignore that pointer.** This v2 spec + `specs/decisions/interactive-subagents-v2-decisions.md` are the source of truth. v1 spec is historical context only.

v2 enriches v1's parent ↔ child coordination with three additive features. **The launch model stays blocking.** No async injection, no mailbox queues, no user-takeover detection.

### Three Features

1. **Structured exit sidecar** — Replace v1's write-only signal file (`<stateDir>/done/<copilotSessionId>`) with a JSON sidecar at `<stateDir>/exit/<launchId>.json` carrying `{version, type, writtenAt, launchId, summary?, message?, exitCode?}`.
2. **`caller_ping`** — New child-only tool. Writes sidecar with `type:"ping"`, returns a tool result instructing the model to end its turn. Best-effort shutdown (no SDK termination primitive). Parent's blocking launch tool resolves with `{status:"ping", ping:{message}, ...}`.
3. **Tool access control** — When `process.env.COPILOT_SUBAGENT_LAUNCH_ID` is set at extension load (set unconditionally for every backend by `lib/backend-ops.mjs:244-246`), exclude all five public spawning tools — both their snake_case names AND their camelCase aliases (10 names total, see `lib/tool-schemas.mjs:218-223`) — from `tools[]` passed to `joinSession`. Children retain `subagent_done` + `caller_ping`.

### Code Map (spec concept → today's code)

A fresh agent should bookmark this table; spec sections refer to these symbols by name.

| Spec concept | File | Symbol / line | Notes |
|---|---|---|---|
| Tool registration | `extension.mjs` | `registerExtensionSession` (~line 470+) | Where `tools[]` is built before `joinSession({tools})` |
| `subagent_done` registration | `extension.mjs` | gated block (~line 496-510) | Template for how `caller_ping` should be registered |
| Pane open + child spawn | `lib/backend-ops.mjs` | `openPane`, `createDefaultAgentLaunchCommand` | `COPILOT_SUBAGENT_LAUNCH_ID` env wired here (line 244-246) |
| v1 signal file (DEAD) | `lib/backend-ops.mjs` | `writeSignalFile` (line 250-258) | Write-only-never-read; deleted in cleanup |
| Sentinel emitted | `lib/backend-ops.mjs` | `runnerScript` (line 225-235) | `__SUBAGENT_DONE_<exitCode>__` echo |
| Manifest CRUD | `lib/state.mjs` | `METADATA_VERSION` (line 6), `createLaunchRecord`, `readLaunchRecord` | Single rejection layer for unsupported versions |
| Parent's blocking poll | `lib/summary.mjs` | `waitForLaunchCompletion` (line 170+) | Where sidecar-first read lands |
| Summary extraction (pane) | `lib/summary.mjs` | `extractLaunchSummary`, `extractSessionSummary` | Fallback when sidecar absent |
| Launch result shaping | `lib/launch.mjs` | mainline at lines 30, 39, 305-308 | Where `status:"ping"` is mapped from sidecar |
| Resume entrypoint | `lib/resume.mjs` | resume handler | Adds `task` delivery + sidecar cleanup + `respondedAt` |
| Parallel aggregation | `lib/progress.mjs` | aggregator (line 35-61, 100) | Add `pingCount`; treat `"ping"` as non-failure |
| Tool name catalog | `lib/tool-schemas.mjs` | `PUBLIC_TOOL_NAMES` (line 7-12), `TOOL_NAME_ALIASES` (line 218-223) | Both snake & camel must be filtered |
| Resume schema (current) | `lib/tool-schemas.mjs` | `copilot_subagent_resume` (line 69-84 public, 171-196 JSON Schema) | `task` field added in v2 |

### Module ownership (avoid landing logic in the wrong file)

- **`lib/exit-sidecar.mjs` (new):** owns sidecar I/O only. No status mapping, no manifest mutation.
- **`lib/summary.mjs#waitForLaunchCompletion`:** *observes* sidecar (sidecar-first read) and *returns* its contents. Does NOT mutate manifest, does NOT shape final `status` value beyond passing through what sidecar said.
- **`lib/launch.mjs` and `lib/resume.mjs`:** own launch-result shaping (`status:"ping"` mapping) AND manifest mutation (`pingHistory`, `lastExitType`, `respondedAt`). The blocking-launch tool handler is the right place for both.
- **`lib/progress.mjs`:** owns parallel aggregation only (counts). No per-launch shaping.
- **`lib/tool-schemas.mjs`:** owns tool catalog + JSON Schema + public `requestShape`/`resultShape` docs. Updates here must mirror runtime result shape changes elsewhere.

### What to Build (Implementation Waves)

| Wave | Component | File | Action | Depends On | Test File |
|------|-----------|------|--------|------------|-----------|
| 1 | Sidecar writer | `lib/exit-sidecar.mjs` (**new**) | Create | — | `test/unit/exit-sidecar.test.mjs` (new) |
| 1 | Manifest v3 schema | `lib/state.mjs` | Update | — | `test/state-store.test.mjs` (update) |
| 2 | `subagent_done` switches to sidecar | `extension.mjs` | Update | Wave 1 sidecar | `test/unit/subagent-done.test.mjs` (update) |
| 2 | `caller_ping` tool | `extension.mjs` | Add | Wave 1 sidecar | `test/unit/caller-ping.test.mjs` (new) |
| 2 | Sidecar reader in poll loop (sidecar-first ordering) | `lib/summary.mjs` (`waitForLaunchCompletion`) | Update | Wave 1 sidecar | `test/unit/summary-extraction.test.mjs` (update) |
| 2 | Launch returns `status:"ping"` | `lib/launch.mjs`, `lib/resume.mjs` | Update | Wave 2 reader | `test/unit/launch-result.test.mjs` (update) |
| 2 | Parallel aggregation handles `"ping"` status | `lib/progress.mjs` | Update | Wave 2 launch | `test/parallel-aggregate.test.mjs` (update) |
| 3 | Strip spawning tools (snake + camel aliases) in children | `extension.mjs`, `lib/tool-schemas.mjs` (export filter set) | Update | — | `test/unit/tool-registration.test.mjs` (new) |
| 3 | Resume cleanup of new sidecar path | `lib/resume.mjs` | Update | Wave 1 sidecar | `test/unit/resume-cleanup.test.mjs` (update) |
| 4 | Drop `writeSignalFile` & `done/` cleanup | `lib/backend-ops.mjs`, `extension.mjs`, `lib/resume.mjs` | Delete code | All above tests green | — (negative tests already cover) |

Wave 1 produces the data primitive. Wave 2 wires it into the existing blocking-poll architecture. Wave 3 is independent and can ship parallel to Wave 1-2. Wave 4 removes the dead v1 path.

## Problem Statement

v1's parent-child IPC has three gaps:

1. **The "done" signal carries no structured data.** v1 writes `<timestamp>|<launchId>` to a plain text file that is never read; explicit summaries flow through a separate pane-output extraction path. Adding new exit information (e.g., a help request) requires inventing parallel mechanisms.
2. **Children cannot ask the parent for help mid-task.** A stuck child can only crash, complete with an unhelpful summary, or hallucinate. The parent has no signal to resume the session with clarification.
3. **Children can spawn further children.** Nothing prevents a delegated subagent from calling `copilot_subagent_launch` recursively, leading to runaway fan-out, confused orchestration, and rate-limit contention.

## Scope

### In Scope

- Replace v1 signal file with structured JSON exit sidecar.
- Add `caller_ping` tool registered only in child sessions.
- Filter all five public spawning tools out of children's tool registration.
- Bump manifest version to 3 (hard cutover; user is sole consumer of unpublished package).
- Update parent's blocking poll loop to detect sidecar and surface ping status as a launch tool result.
- Update resume to delete new sidecar path and reject v2 manifests with a clear error.

### Out of Scope

- Async parent ↔ child injection / non-blocking launch (deferred indefinitely; see decisions doc).
- User-takeover detection (depends on async; deferred).
- Per-launch `denyTools` parameters; broader sandboxing using SDK `availableTools`/`excludedTools`.
- Auto-exit lifecycle hooks (no SDK equivalent).
- Artifact system, live progress widget, WezTerm backend.
- Pane-script command delivery (separate cleanup, not v2-gated).
- Backward compatibility with v2 manifests.

## Design Decisions

See `specs/decisions/interactive-subagents-v2-decisions.md` for locked decisions with rationale. Summary:

| Decision | Choice |
|---|---|
| Sidecar file strategy | Replace v1 signal file |
| Sidecar schema | Richer (version, writtenAt, launchId, etc.) |
| `caller_ping` return shape | Augmented success (new `status:"ping"`, `summary:null` always) |
| Launch model | Blocking (pi-style) |
| Resume-after-ping context | Parent's `task` only (extend resume schema with optional `task: string`) |
| Spawning tools to strip | All 5 — both snake_case AND camelCase aliases (10 names) |
| Child marker env var | `COPILOT_SUBAGENT_LAUNCH_ID` (works across all backends) |
| Manifest versioning | Hard cutover to v3 |
| Status taxonomy | Existing `success\|failure\|timeout\|cancelled` + new `ping` |
| Sidecar/sentinel precedence | Sidecar checked first every tick; sidecar wins |
| Child shutdown | Best-effort: tool returns + model ends turn + `copilot -p` exits |

## Architecture

### Component Overview

```
                    ┌───────────────────────┐
                    │ Parent copilot session│
                    │  (extension running)  │
                    └─────────┬─────────────┘
                              │ tool call: copilot_subagent_launch
                              ▼
              ┌──────────────────────────────────┐
              │ launch.mjs / parallel.mjs        │
              │  - opens pane via mux            │
              │  - blocking poll loop            │
              │  - reads pane sentinel + sidecar │ ◄─── reads
              └─────────┬─────────────────┬──────┘      │
                        │ spawn pane      │             │
                        ▼                 │             │
              ┌──────────────────┐        │       ┌────────────────────┐
              │ Child copilot    │        │       │ <stateDir>/exit/   │
              │ (extension fork) │        │       │  <launchId>.json   │
              │  - subagent_done │ ──────────────►│  (sidecar)         │
              │  - caller_ping   │ writes JSON    └────────────────────┘
              │  - NO spawning   │                         ▲
              │    tools         │                         │
              └──────────────────┘                         │
                        │                                  │
                        └─ ctx exits ─► pane sentinel ◄────┘
                                       (__SUBAGENT_DONE_N__)
```

### Data / Control Flow

**Done path (existing, restructured):**
1. Child agent calls `subagent_done`.
2. Tool handler writes `{version:1, type:"done", writtenAt, launchId, summary, exitCode:0}` to `<stateDir>/exit/<launchId>.json` via `lib/exit-sidecar.mjs#writeExitSidecar`.
3. Tool returns `{ok:true, message:"Session is terminating. Do not call further tools. End your turn."}`. Best-effort: model ends turn; `copilot -p` exits; wrapper script emits `__SUBAGENT_DONE_0__` sentinel.
4. Parent poll loop in `lib/summary.mjs#waitForLaunchCompletion` reads sidecar **first** every tick (see precedence rule below).
5. Returns `{status:"success", summary, exitCode, ...}` from launch tool call (existing v1 status, sourced from sidecar).

**Ping path (new):**
1. Child agent calls `caller_ping({message:"Need DB schema"})`.
2. Tool handler writes `{version:1, type:"ping", writtenAt, launchId, message}` to sidecar.
3. Tool returns `{ok:true, message:"Ping sent. Session is terminating. Do not call further tools. End your turn."}`. Best-effort shutdown (same as done path).
4. Parent poll reads sidecar, sees `type:"ping"`.
5. Returns `{status:"ping", ping:{message}, launchId, sessionId, paneId, summary:null, exitCode:0, ...}` from launch tool call.
6. Parent agent inspects status, decides to call `copilot_subagent_resume({launchId, task:<response>})` (NB: v2 **adds** the optional `task` field to the resume schema; see `lib/tool-schemas.mjs` change in modify list) or terminate.
7. Manifest gains `pingHistory` entry: `{message, sentAt, respondedAt?}` updated when resume fires.

**Sidecar / sentinel precedence (authoritative rule — DO NOT DEVIATE):**

> 🔒 **The parent's first observed sidecar snapshot wins.** Once `readExitSidecar` returns non-null on any tick, the launch result is finalized from that snapshot. The pane sentinel is a trailing pane-lifecycle signal only. If a fresh agent skips this rule and waits on the sentinel, hangs and incorrect final state are guaranteed.

Each poll tick of `waitForLaunchCompletion`:

1. Call `readExitSidecar({launchId, stateDir})`.
2. **If sidecar present** → finalize result from sidecar (`status:"ping"` if `type:"ping"`, else `status:"success"`). Wait for sentinel (with short bounded timeout) only to release the pane; if sentinel never arrives, log a warning and proceed.
3. **If sidecar absent**:
   - Check pane buffer for `__SUBAGENT_DONE_<N>__` sentinel.
   - If sentinel found → re-read sidecar **once more** (captures late writes that landed between previous tick and now). If still null → fall back to v1 pane-scrape summary; map exit code via existing `mapExitState`.
   - If sentinel absent → continue polling.

Sidecar is the **single source of truth** for explicit completion. Sentinel is the trailing pane-lifecycle signal.

**Tool registration (child-only):**
1. Extension module loads in child process (forked by `copilot` CLI launched by mux backend).
2. `process.env.COPILOT_SUBAGENT_LAUNCH_ID` is set unconditionally for every backend by `lib/backend-ops.mjs:244-246` (cmux, tmux, zellij). NB: we use `LAUNCH_ID` not `SESSION_ID` because cmux launches set `copilotSessionId: null` (`lib/launch.mjs:364`).
3. `registerExtensionSession` builds `tools[]` from handlers, then filters out **all 10** spawning tool names — the 5 snake_case names AND their 5 camelCase aliases — then appends `subagent_done` + `caller_ping`.
4. `joinSession({tools})` registers only the filtered set. SDK enforcement is the trust boundary: tools not in this list cannot be invoked by the model.

### Integration Points

- **Mux backends** (`lib/mux.mjs`, `lib/backend-ops.mjs`): No changes to sentinel detection. Wave 4 deletes `writeSignalFile`.
- **State store** (`lib/state.mjs`): Manifest v3 schema; `pingHistory`, `lastExitType`, `sidecarPath` fields added; **`readLaunchRecord` is the single rejection layer** for unsupported `metadataVersion` (throws `MANIFEST_VERSION_UNSUPPORTED`). All callers (resume, status, list) propagate the error.
- **Resume** (`lib/resume.mjs`): Cleans sidecar (`<stateDir>/exit/<launchId>.json`) instead of `done/<copilotSessionId>` on stale-cleanup; updates `pingHistory[last].respondedAt` when resuming after a ping. Does NOT re-validate manifest version (relies on `readLaunchRecord`).
- **Summary extraction** (`lib/summary.mjs#waitForLaunchCompletion`): Reads sidecar via new `readExitSidecar` (sidecar-first precedence above); summary source priority: `sidecar.summary` > pane scrape > fallback message.
- **Parallel aggregation** (`lib/progress.mjs`): Aggregator currently keys off `status === "success"` and `"failure"`/`"timeout"`/`"cancelled"`. Add `"ping"` to the "non-failure" bucket; expose `pingCount` alongside `successCount`. `every()` checks for cancelled/timeout uniformity remain unchanged.
- **Tool schemas** (`lib/tool-schemas.mjs`): Export a `PUBLIC_SPAWNING_TOOL_NAMES` set covering both snake_case and camelCase aliases, used by the registration filter.

### Architecture Diagram

(See Component Overview above.)

### Key Interfaces

**`lib/exit-sidecar.mjs`** (new, ~80 LoC)

```js
// Writer (called by child tools)
export function writeExitSidecar({
  launchId,
  type,            // "done" | "ping"
  summary,         // optional string
  message,         // optional string (required for "ping")
  exitCode,        // optional number
  stateDir,        // defaults to ".copilot-interactive-subagents"
  services,        // DI for fs/now
}): void

// Reader (called by parent poll loop)
export function readExitSidecar({
  launchId,
  stateDir,
  services,
}): null | {
  version: 1,
  type: "done" | "ping",
  writtenAt: string,
  launchId: string,
  summary?: string,
  message?: string,
  exitCode?: number,
}

// Cleanup (called by resume)
export function deleteExitSidecar({ launchId, stateDir, services }): void

// Schema (exported for tests)
export const SIDECAR_VERSION = 1;
export const SIDECAR_DIRNAME = "exit";
```

**Sidecar JSON schema:**

```jsonc
// type: "done"
{
  "version": 1,
  "type": "done",
  "writtenAt": "2026-04-17T18:00:00.000Z",
  "launchId": "abc-123",
  "summary": "Refactored auth module; tests green.",
  "exitCode": 0
}

// type: "ping"
{
  "version": 1,
  "type": "ping",
  "writtenAt": "2026-04-17T18:00:00.000Z",
  "launchId": "abc-123",
  "message": "Need clarification: should I migrate the legacy users table or skip it?"
}
```

**`caller_ping` tool registration (in `extension.mjs`, child-only branch):**

```js
{
  name: "caller_ping",
  description:
    "Send a help request to the caller agent and exit this session. " +
    "The caller will be notified with your message and can resume this session " +
    "with a response. Use when stuck, need clarification, or need the caller to act.",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "What you need help with" },
    },
    required: ["message"],
  },
  handler: ({ message }) => {
    if (!message || typeof message !== "string" || message.trim() === "") {
      return { ok: false, error: "message required" };
    }
    writeExitSidecar({
      launchId: process.env.COPILOT_SUBAGENT_LAUNCH_ID,
      type: "ping",
      message,
    });
    return {
      ok: true,
      message: "Ping sent. Session is terminating. Do not call further tools. End your turn.",
    };
  },
}
```

**Child shutdown reality — read this:** Copilot CLI tool handlers cannot terminate the session (no `ctx.shutdown()` SDK primitive). A child terminates only when its model finishes its assistant turn, after which `copilot -p "<task>"` exits naturally and the wrapper script emits the sentinel. Both `subagent_done` and `caller_ping` therefore rely on:

1. **Synchronous sidecar write** — sidecar is on disk before the tool returns.
2. **Tool return message instructs the model to stop** — explicit "Do not call further tools. End your turn."
3. **Parent stops watching once sidecar appears** — model misbehavior after the write doesn't change the parent's outcome.

This is best-effort. If a misbehaving model keeps calling tools after the sidecar write, the parent has already finalized; the child eventually times out at the pane sentinel timeout. We accept this gap; documenting it is the deliverable.

**State transitions (manifest `pingHistory` / `lastExitType`):**

| Event | `lastExitType` change | `pingHistory` change |
|---|---|---|
| Launch created | → `null` | → `[]` |
| Child writes `type:"done"` sidecar; parent finalizes | → `"done"` | unchanged |
| Child writes `type:"ping"` sidecar; parent finalizes | → `"ping"` | append `{message, sentAt: <sidecar.writtenAt>}` |
| Resume invoked while `lastExitType === "ping"` | → `null` (cleared on relaunch) | set `pingHistory[last].respondedAt = <now>` before clearing |
| Resume invoked while `lastExitType !== "ping"` | → `null` | unchanged |
| Sidecar deleted on cleanup | unchanged | unchanged |

**Launch tool result shape (extends existing — note: existing taxonomy uses `success`/`failure`, NOT `complete`/`failed`):**

```js
// status:"success" — existing (v1 unchanged); summary now sourced from sidecar when present
{ status: "success", launchId, sessionId, paneId, summary, exitCode, ... }

// status:"ping" — NEW
{ status: "ping", launchId, sessionId, paneId, ping: { message }, summary: null, exitCode: 0, ... }

// status:"failure" / "timeout" / "cancelled" — existing v1 values, unchanged
```

**Parallel aggregate shape (extends existing):**

```js
{
  total, successCount, pingCount /* NEW */, failureCount, timeoutCount, cancelledCount,
  results: [/* per-launch result objects above */]
}
```

**Manifest v3 schema (additions over v2):**

```js
{
  // ...all existing v2 fields...
  metadataVersion: 3,
  pingHistory: [
    { message: string, sentAt: ISO8601, respondedAt?: ISO8601 }
  ],
  lastExitType: "done" | "ping" | null,
  sidecarPath: string | null,  // absolute path to last exit sidecar
}
```

**Tool stripping (in `registerExtensionSession`, exported set lives in `lib/tool-schemas.mjs`):**

> **Filter the built `tools[]` array AFTER alias expansion.** Filtering the handler map (or the catalog before alias expansion) leaves the camelCase aliases registered. The 10-name set below is post-expansion.

```js
// lib/tool-schemas.mjs (new export)
export const PUBLIC_SPAWNING_TOOL_NAMES = new Set([
  // snake_case (PUBLIC_TOOL_NAMES, lines 7-12)
  "copilot_subagent_launch",
  "copilot_subagent_parallel",
  "copilot_subagent_resume",
  "copilot_subagent_set_title",
  "copilot_subagent_list_agents",
  // camelCase aliases (TOOL_NAME_ALIASES, lines 218-223) — must also be filtered
  "copilotSubagentLaunch",
  "copilotSubagentParallel",
  "copilotSubagentResume",
  "copilotSubagentSetTitle",
  "copilotSubagentListAgents",
]);

// extension.mjs registerExtensionSession
const isChild = Boolean(process.env.COPILOT_SUBAGENT_LAUNCH_ID);  // NB: LAUNCH_ID, not SESSION_ID
let tools = buildSdkTools(handlers);
if (isChild) {
  tools = tools.filter((t) => !PUBLIC_SPAWNING_TOOL_NAMES.has(t.name));
  tools.push(subagentDoneTool);
  tools.push(callerPingTool);
} else {
  // Parent retains all spawning tools; subagent_done & caller_ping NOT registered
}
```

## What Changes

### New Files

- `lib/exit-sidecar.mjs` — write/read/delete sidecar with DI-friendly services.
- `test/unit/exit-sidecar.test.mjs` — schema, atomicity, missing-file behavior.
- `test/unit/caller-ping.test.mjs` — tool handler writes correct sidecar.
- `test/unit/tool-registration.test.mjs` — parent gets all 5 spawning tools + neither child tool; child gets neither spawning tool + both child tools.
- `test/unit/launch-result.test.mjs` — `status:"ping"` payload shape.

### Modified Files

| File | Change | Approx LoC |
|---|---|---|
| `extension.mjs` | Refactor `subagent_done` to use sidecar; add `caller_ping`; gate child-only tools on `COPILOT_SUBAGENT_LAUNCH_ID`; apply `PUBLIC_SPAWNING_TOOL_NAMES` filter | ~50 |
| `lib/tool-schemas.mjs` | Export `PUBLIC_SPAWNING_TOOL_NAMES` set (10 names: snake + camelCase); **add optional `task: string` field to `copilot_subagent_resume` schema** (request shape + JSON Schema); update public `resultShape` docs for `copilot_subagent_launch`/`_resume`/`_parallel` to include `status:"ping"` and `ping: { message }` | ~25 |
| `lib/state.mjs` | Bump `METADATA_VERSION` to 3; add `pingHistory`/`lastExitType`/`sidecarPath` fields to `createLaunchRecord`; `readLaunchRecord` rejects non-v3 manifests with `MANIFEST_VERSION_UNSUPPORTED` (single layer) | ~30 |
| `lib/summary.mjs` | `waitForLaunchCompletion`: sidecar-first precedence; extract ping payload; prefer `sidecar.summary` over pane scrape | ~40 |
| `lib/launch.mjs` | Return `status:"ping"` shape when `sidecar.type === "ping"`; update `pingHistory` + `lastExitType` in manifest | ~25 |
| `lib/progress.mjs` | Add `pingCount` aggregate; treat `"ping"` as non-failure in `every()`/aggregation logic | ~15 |
| `lib/resume.mjs` | Accept new optional `task` parameter — when provided, deliver as launch prompt to the resumed child. **Threading path:** schema → tool handler → `resume.mjs` → must update BOTH delivery branches (the `openPaneAndSendCommand` path AND the fallback `launchAgentInPane` path); grep `resume.mjs` for both call sites. Also: delete sidecar (not signal file) on stale cleanup; update `pingHistory[last].respondedAt` when resuming after ping; clear `lastExitType` on relaunch | ~40 |
| `lib/backend-ops.mjs` | **Delete** `writeSignalFile` (Wave 4) | -10 |
| `test/state-store.test.mjs` | Cover v3 fields and v2 rejection | +20 |
| `test/unit/summary-extraction.test.mjs` | Cover sidecar-first precedence and late-write capture | +30 |
| `test/unit/resume-cleanup.test.mjs` | Cover new sidecar path; `respondedAt` update | +20 |
| `test/unit/subagent-done.test.mjs` | Cover sidecar write (was: signal file) | +15 |
| `test/parallel-aggregate.test.mjs` | Cover `pingCount` and `"ping"` non-failure handling | +15 |

### Deleted Code (Wave 4, after all tests green)

- `writeSignalFile` export from `lib/backend-ops.mjs` (lines 250-258).
- All `done/<copilotSessionId>` write/cleanup code paths.
- v2 manifest acceptance branches in `lib/state.mjs` and `lib/resume.mjs`.

## Failure Modes / Risks

| Failure mode | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Misbehaving model calls another tool after `caller_ping` | Medium | Extra tool calls run in child; parent already finalized | Parent's outcome is fixed once sidecar appears; document as accepted gap (no SDK shutdown primitive available) |
| Sidecar write fails (disk full, permissions) | Low | Child can't signal completion; parent waits for sentinel | Tool handler catches and returns `{ok:false, error}`; child agent sees error in tool result; sentinel still triggers eventual timeout |
| Sidecar JSON corrupted (partial write) | Very Low | Parent reads partial JSON, parser throws | Optional: write to `<launchId>.json.tmp` then `rename()`. Pi gets away with bare write; we can match |
| Child crashes before writing sidecar | Medium | No sidecar; parent falls back to sentinel + pane scrape (same as v1 today) | Existing behavior preserved; sidecar is additive |
| Race: child writes sidecar then crashes mid-shutdown | Low | Sidecar exists, sentinel may be missing/garbled | Parent prefers sidecar when present; sentinel is fallback |
| Stale sidecar from previous launch (resume reuses launchId) | Low | Parent reads old data | Resume deletes sidecar before relaunching the child |
| Child uses old binary that doesn't write sidecar | N/A | Pre-v2 child doesn't exist; package unpublished | — |
| `caller_ping` called multiple times in same turn (or `caller_ping` then `subagent_done`) | Low | Each call rewrites the sidecar (no file lock); parent observes whichever snapshot it reads | First write to land before parent's tick wins; per-tick atomicity is the parent-side guarantee. State (`lastExitType`, `pingHistory`) reflects whichever sidecar the parent's `readExitSidecar` snapshot returned. Misbehavior is bounded to "extra noise" — outcome is deterministic per parent-tick. |
| `caller_ping` called from parent (mistakenly) | Low | Tool not registered in parent; model can't call it | Tool only appears in child's `tools[]` |
| Spawning tool stripped but model recalls it from training data | Low | Tool call rejected by SDK ("unknown tool") | SDK enforcement is the trust boundary |
| `COPILOT_SUBAGENT_LAUNCH_ID` env var leaked to unrelated process | Very Low | Unrelated process loses spawn tools | Env var is only set by our launch command builder |

## Testing Strategy

### Work types and rigor

| Component | Work type | Rigor |
|---|---|---|
| `lib/exit-sidecar.mjs` | business-logic | Full TDD, mutation testing ≥80%, CRAP < 8 |
| `extension.mjs` tool registration filter | business-logic | Full TDD, CRAP < 8 |
| `extension.mjs` `caller_ping` handler | business-logic | TDD with `services` DI |
| `lib/state.mjs` v3 schema | business-logic | Update existing tests; CRAP gate |
| `lib/summary.mjs` sidecar read priority | business-logic | TDD update; CRAP gate |
| `lib/launch.mjs` / `lib/resume.mjs` ping wiring | api-contract | TDD; integration coverage in `test/integration/` |
| `lib/backend-ops.mjs` deletion (Wave 4) | refactor | Existing tests; verify no regressions |

### Acceptance Criteria (GIVEN/WHEN/THEN)

**Wave 1 — Sidecar primitive:**

- GIVEN a launchId and `stateDir`, WHEN `writeExitSidecar({type:"done", summary:"x", launchId, exitCode:0})` is called THEN a file at `<stateDir>/exit/<launchId>.json` exists with `{version:1, type:"done", writtenAt:<ISO>, launchId, summary:"x", exitCode:0}`.
- GIVEN a launchId and `stateDir`, WHEN `writeExitSidecar({type:"ping", message:"need help", launchId})` is called THEN file contents include `type:"ping"` and `message:"need help"` (no summary, no exitCode).
- GIVEN no sidecar exists for launchId, WHEN `readExitSidecar({launchId, stateDir})` is called THEN it returns `null` (no throw).
- GIVEN a sidecar with malformed JSON, WHEN `readExitSidecar` is called THEN it returns `null` and logs a warning (no throw).
- GIVEN a sidecar exists, WHEN `deleteExitSidecar({launchId, stateDir})` is called THEN the file is removed; subsequent `readExitSidecar` returns `null`.
- GIVEN `services.writeFileSync` is injected, WHEN `writeExitSidecar` is called THEN the injected function is used (DI proven).

**Wave 1 — Manifest v3:**

- GIVEN a freshly created launch record, WHEN serialized THEN `metadataVersion === 3`.
- GIVEN a v3 record, WHEN serialized then deserialized THEN `pingHistory`, `lastExitType`, `sidecarPath` round-trip with defaults `[]`, `null`, `null`.
- GIVEN a v2 manifest on disk, WHEN `readLaunchRecord` is called THEN it throws an error with code `MANIFEST_VERSION_UNSUPPORTED` and a message naming the unsupported version.
- GIVEN a v2 manifest reached via the state-index path that bypasses `readLaunchRecord` (e.g., `planResumeSession`), WHEN `validateManifest` runs THEN it throws the same typed `MANIFEST_VERSION_UNSUPPORTED` error (defense-in-depth — both gates reject identically; legacy `{ok:false}` shape is not used).
- GIVEN a v2 manifest on disk, WHEN `copilot_subagent_resume({launchId})` is invoked THEN the call propagates the same `MANIFEST_VERSION_UNSUPPORTED` error (no swallowing; `withToolTimeout` does NOT remap it to `TOOL_TIMEOUT`).

**Wave 2 — Child tools:**

- GIVEN `process.env.COPILOT_SUBAGENT_LAUNCH_ID` is set, WHEN child agent calls `subagent_done` THEN sidecar at `<stateDir>/exit/<launchId>.json` exists with `type:"done"` and the tool returns `{ok:true, message:/End your turn/}`.
- GIVEN a child session, WHEN `caller_ping({message:"X"})` is called THEN sidecar exists with `type:"ping", message:"X"` and the tool returns `{ok:true, message:/Ping sent.*End your turn/}`.
- GIVEN `caller_ping` is called with empty/whitespace/non-string message, WHEN executed THEN tool returns `{ok:false, error:/message required/}` and no sidecar is written.

**Wave 2 — Parent poll & launch result (sidecar-first precedence):**

- GIVEN child wrote `type:"done"` sidecar, WHEN parent's poll loop completes THEN launch tool resolves with `{status:"success", summary:<sidecar.summary>, exitCode:0, ...}`.
- GIVEN child wrote `type:"ping"` sidecar, WHEN parent's poll loop completes THEN launch tool resolves with `{status:"ping", ping:{message:<sidecar.message>}, summary:null, sessionId, launchId, ...}`.
- GIVEN sidecar appears BEFORE sentinel within the same tick, WHEN `waitForLaunchCompletion` runs THEN it returns the sidecar-derived result without waiting indefinitely for the sentinel (sentinel waited for only as pane-release signal with bounded timeout).
- GIVEN sentinel appears BEFORE sidecar, WHEN poll loop sees sentinel THEN it performs ONE additional `readExitSidecar` call (capturing late writes) before falling back to v1 pane scrape.
- GIVEN no sidecar AND sentinel detected, WHEN poll loop completes THEN existing v1 fallback (pane scrape) applies and `status` derives from `mapExitState`.

**Wave 2 — Manifest ping tracking:**

- GIVEN a launch with `lastExitType:null`, WHEN child pings THEN manifest is updated with `lastExitType:"ping"` and `pingHistory[0] = {message, sentAt:<sidecar.writtenAt>}`.
- GIVEN a manifest with `lastExitType:"ping"`, WHEN parent calls `copilot_subagent_resume({launchId, task})` THEN `pingHistory[last].respondedAt = <now>` is set BEFORE relaunch, then `lastExitType` is cleared to `null`.

**Wave 2 — Parallel aggregation:**

- GIVEN three launches resolving as `success`, `ping`, `failure`, WHEN aggregator runs THEN result includes `successCount:1, pingCount:1, failureCount:1`.
- GIVEN all launches resolve as `ping`, WHEN aggregator runs THEN top-level status reflects "all completed without failure" (NOT degraded to `failure`).

**Wave 3 — Tool access control:**

- GIVEN `process.env.COPILOT_SUBAGENT_LAUNCH_ID` is unset, WHEN extension registers tools THEN all 5 public spawning tools (and their 5 camelCase aliases) are present AND `subagent_done` is absent AND `caller_ping` is absent.
- GIVEN `process.env.COPILOT_SUBAGENT_LAUNCH_ID` is set, WHEN extension registers tools THEN none of the 10 spawning-tool names (snake or camelCase) are present AND `subagent_done` is present AND `caller_ping` is present.
- GIVEN the registered tool list, WHEN scanning by name THEN no name in `PUBLIC_SPAWNING_TOOL_NAMES` appears (covers both casings).
- GIVEN a cmux-launched child (where `COPILOT_SUBAGENT_SESSION_ID` is null), WHEN extension loads THEN gating still applies because `COPILOT_SUBAGENT_LAUNCH_ID` is set.

**Wave 3 — Resume cleanup & `task` field:**

- GIVEN `copilot_subagent_resume({launchId, task:"continue with X"})`, WHEN resume executes THEN the resumed child receives `"continue with X"` as its launch prompt (same delivery path as initial `copilot_subagent_launch`).
- GIVEN `copilot_subagent_resume({launchId})` (no `task`), WHEN resume executes THEN behavior matches v1 (resume original session without a new prompt).
- GIVEN a stale sidecar exists for a launchId, WHEN `copilot_subagent_resume({launchId, task})` is called THEN the sidecar is deleted before the child is relaunched.
- GIVEN a manifest with `pingHistory` entries and `lastExitType:"ping"`, WHEN resume completes setup (before relaunch) THEN the most recent ping's `respondedAt` is set and `lastExitType` is cleared.

### Adversarial Test Cases

1. **Concurrent sidecar write + read**: Parent reads sidecar at the exact moment child writes it (simulated via ordering in test). Verify reader either sees full JSON or `null`, never partial.
2. **`caller_ping` then `subagent_done` race**: Both tools called in same turn (misbehaving model — there is no SDK shutdown primitive to prevent this). Behavior: each call rewrites the sidecar (no file lock); the parent's `readExitSidecar` snapshot is atomic per tick — whichever sidecar contents are present at that snapshot determine the finalized outcome. Verify: (a) the parent's launch result is deterministic given a snapshot; (b) `lastExitType`/`pingHistory` reflect the snapshot the parent observed. Document that "first write wins" applies to the parent-observed snapshot, not to the file itself.
3. **Parent crashes between sidecar read and tool resolution**: Subsequent resume sees sidecar exists; cleanup deletes it; relaunch doesn't see stale ping.
4. **Two parallel launches with same agentIdentifier but different launchIds**: Each gets its own sidecar; no cross-contamination.
5. **Child has env var unset due to launch command bug**: Child gets parent's tool set, can recursively spawn. Verify CI test exists that asserts `COPILOT_SUBAGENT_LAUNCH_ID` is in the launch command for ALL backends (cmux, tmux, zellij).
6. **cmux child gating regression**: GIVEN cmux launch path that historically set `copilotSessionId: null`, WHEN child loads extension THEN child still has spawning tools stripped (because `COPILOT_SUBAGENT_LAUNCH_ID` is the gate, not `COPILOT_SUBAGENT_SESSION_ID`).
7. **Misbehaving model continues calling tools after `caller_ping`**: Tool calls return normally (no in-process termination); parent has already finalized once sidecar appeared; child eventually times out at sentinel. Verify parent's result is unaffected.

### Test Harness

Existing: `node:test` + `node:assert`, DI via `services` parameter, `test/helpers/red-harness.mjs#importProjectModule`. Quality gates: `npm test`, `npm run test:crap`, `npm run test:mutation`. Add new modules to `scripts/quality/targets.mjs`.

## Validation Lenses

| Lens | Result | Notes |
|---|---|---|
| **product-fit** | ✅ Pass | Solves stated problems (no structured exit, no help-request, no recursion guard) without scope creep. Async injection deliberately deferred. |
| **architecture-fit** | ✅ Pass | Reuses existing blocking-poll pattern, DI conventions, manifest store, registration-time tool gating (mirrors v1 `subagent_done`). No new architectural primitives. |
| **operability** | ✅ Pass | Sidecar path is deterministic and human-readable; manifest carries `pingHistory` for diagnosis; resume cleans up; quality gates apply. Failure modes have clear fallbacks. |
| **traceability** | ✅ Pass | Every decision traces to `specs/decisions/interactive-subagents-v2-decisions.md`. Spec lines referenced in ticket Quick Starts. |
| **change-impact** | ✅ Pass | Hard cutover acknowledged (unpublished package, single user). v1 dead signal-file code is removed in Wave 4. Existing launch tool result shape is extended with one new `status` value (`"ping"`); existing `success`/`failure`/`timeout`/`cancelled` taxonomy is unchanged. Parallel aggregation gains `pingCount`. `copilot_subagent_resume` schema is **additively** extended with an optional `task: string` field — backward compatible (omit → v1 behavior). |

## References

- v1 spec: `specs/subagents/interactive-subagents-v1.md`
- v2 exploration (now superseded): `specs/explorations/interactive-subagents-v2.md`
- pi-interactive-subagents v2.2.0 (reference impl): `~/.projects/oss/pi-interactive-subagents/`
- Pi `caller_ping` source: `pi-extension/subagents/subagent-done.ts:151-183`
- Pi `pollForExit`: `pi-extension/subagents/cmux.ts:660-741`
- SDK learning-test artifacts: `specs/learning-tests/`
