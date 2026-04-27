# Interactive Subagents v2.1

Live multi-turn conversation between parent and child via mux `send-keys` + append-only ping sidecar. Long-lived warm workers, parallel agent pools.

## Traceability

- **Shared Key**: interactive-subagents-v2.1
- **Spec Path**: specs/subagents/interactive-subagents-v2_1.md
- **Decision Refs**: specs/decisions/interactive-subagents-v2_1-decisions.md
- **Predecessor**: specs/subagents/interactive-subagents-v2.md

## Start Here

> **Read this section first. Use the "Code Map" and "What to Build" tables to find your component.**

> ⚠️ **Override of `AGENTS.md`:** AGENTS.md still points at the v1 spec as "implementation source of truth." For v2.1 work, **ignore that pointer.** This spec + `specs/decisions/interactive-subagents-v2_1-decisions.md` are the source of truth. v2.0 spec remains the source for everything not explicitly changed here.

### The problem v2.1 solves

v2.0 made the parent ↔ child loop usable for one-shot RPC: child works → exits via `subagent_done` or `caller_ping` → parent observes the result and (optionally) calls `resume` to revive a fresh copilot process pointed at the same conversation.

This means **every back-and-forth pays for a copilot startup**. It also means `resume` deliberately refuses to act on a session whose pane is still alive (`SESSION_ACTIVE`), so there is no way today to send a follow-up turn into a child that's just sitting in its REPL waiting.

v2.1 adds the missing primitive: **send a new prompt directly to the live child's pane**. The mechanism is the same one a human uses when they type into the child's pane in interactive mode — `tmux send-keys` / `zellij action write-chars`. Copilot CLI queues input automatically, so no idle detection is required. Combined with a non-exiting child message tool (`copilot_subagent_message`) and a parent-side reader (`copilot_subagent_read_messages`), this gives full-duplex dialogue without inventing new IPC.

### Three new primitives

1. **`copilot_subagent_send(launchId, message, awaitReply?)`** — parent-side. Mux `send-keys` into the child's existing pane. Optionally polls the ping sidecar for the next reply.
2. **`copilot_subagent_message(message)`** — child-side. Append a record to `<stateDir>/pings/<launchId>.jsonl`, return immediately, child keeps working. Distinct from `caller_ping` (which is a lifecycle event).
3. **`copilot_subagent_read_messages(launchId, sinceCursor?)`** — parent-side. Read new ping records since the last cursor.

### Code Map (spec concept → today's code)

| Spec concept | File | Symbol / line | Notes |
|---|---|---|---|
| Tool registration (parent) | `extension.mjs` | `registerExtensionSession` | Where new `_send` / `_read_messages` tools register |
| Tool registration (child) | `extension.mjs` | gated child-tools block | Where `copilot_subagent_message` registers; gated on `COPILOT_SUBAGENT_LAUNCH_ID` |
| Mux send-keys / write-chars | `lib/backend-ops.mjs` | inline in `defaultLaunchAgentInPane` (lines 335–370) — `tmux send-keys` and `zellij action write-chars` calls | No standalone helper today; `lib/send.mjs` (new) wraps the same backend invocations |
| Pane liveness probe | `lib/mux.mjs` | `probeSessionLiveness` (line 320), aliased as `defaultProbeSessionLiveness` in `lib/resume.mjs:11` and used at `lib/resume.mjs:282-283` | Reuse for `send` pre-flight |
| Manifest CRUD | `lib/state.mjs` | `METADATA_VERSION`, `createLaunchRecord`, `readLaunchRecord` | Bump to v4; add `messageCursor` field |
| Exit sidecar (existing) | `lib/exit-sidecar.mjs` | writer + reader | Unchanged in v2.1 |
| Ping sidecar (new) | `lib/ping-sidecar.mjs` (**new — does not exist today**) | append + tail | Append-only JSONL, separate file from exit sidecar; mirror `lib/exit-sidecar.mjs` for atomicity model |
| Tool catalog | `lib/tool-schemas.mjs` | `PUBLIC_TOOL_NAMES` (line 6), `CAMELCASE_HANDLER_NAMES` (line 230), `PUBLIC_SPAWNING_TOOL_NAMES` (line 241) | Add `_send` + `_read_messages` to `PUBLIC_SPAWNING_TOOL_NAMES` (parent-only gating) |
| Lifecycle preamble | `extension.mjs` | `CHILD_LIFECYCLE_PROMPT` | Add `copilot_subagent_message` guidance |

### Module ownership

- **`lib/ping-sidecar.mjs` (new):** owns `pings.jsonl` I/O — `appendPing(launchId, record)`, `readPingsSince(launchId, cursor)`. No status mapping, no manifest mutation.
- **`lib/send.mjs` (new):** owns parent-side `send` orchestration — pane probe, mux send-keys, optional `awaitReply` polling. Imports `lib/ping-sidecar.mjs` for the wait.
- **`lib/read-messages.mjs` (new):** owns parent-side reader — cursor management, batching. Returns `{messages, nextCursor}`.
- **`extension.mjs`:** registers the three new tools; child-side `copilot_subagent_message` calls into `lib/ping-sidecar.mjs` directly.

### What to Build (Implementation Waves)

| Wave | Component | File | Action | Depends On | Test File |
|------|-----------|------|--------|------------|-----------|
| 1 | Ping sidecar I/O | `lib/ping-sidecar.mjs` (**new**) | Create | — | `test/unit/ping-sidecar.test.mjs` (new) |
| 1 | Manifest v4 schema bump | `lib/state.mjs` | Update | — | `test/state-store.test.mjs` (update) |
| 2 | `copilot_subagent_message` tool | `extension.mjs` + `lib/tool-schemas.mjs` | Add (child-only) | W1 ping sidecar | `test/unit/child-message.test.mjs` (new) |
| 2 | `copilot_subagent_send` tool | `lib/send.mjs` (**new**) + `extension.mjs` | Add (parent-only) | W1 ping sidecar (for awaitReply) | `test/unit/send.test.mjs` (new) |
| 2 | `copilot_subagent_read_messages` tool | `lib/read-messages.mjs` (**new**) + `extension.mjs` | Add (parent-only) | W1 ping sidecar | `test/unit/read-messages.test.mjs` (new) |
| 3 | Tool access control update | `lib/tool-schemas.mjs` | Add `_send` + `_read_messages` to gated set | W2 tools | `test/tool-access-control.test.mjs` (update) |
| 3 | Lifecycle preamble update | `extension.mjs` (`CHILD_LIFECYCLE_PROMPT`) | Append `_message` guidance | W2 tools | `test/unit/lifecycle-preamble.test.mjs` (update) |
| 4 | E2E full dialogue loop | new E2E test | Add | All above | `test/e2e/live-dialogue.test.mjs` (new) |
| 5 | Skill docs update | `packages/.../skill/SKILL.md` | Add "Multi-turn dialogue" + "Worker pool" sections | W2 tools | `test/skill-using-extension.test.mjs` (update) |

### Definition of Done

- All three new tools registered and gated correctly (parent-only / child-only).
- Live dialogue E2E: launch interactive child → send → child responds via `_message` → parent reads → send again → child calls `subagent_done` → all messages preserved in `pings.jsonl` and reachable via `read_messages`.
- Pane stays open across N message exchanges; closes only on `subagent_done` or pane death.
- `send` into an autonomous (`-p`) child returns `PANE_DEAD` (or equivalent) after the child exits.
- `awaitReply: true` returns the first ping record appended **after** `sendStartedCursor` (the byte size of `pings.jsonl` captured immediately before send); times out cleanly if none arrives.
- Quality gates: `npm test` 0 failures, CRAP < 8 for new code, mutation ≥ 80% kill rate.
- v2.0 flows unchanged — full v2 test suite passes without modification.

## Tool Schemas

### `copilot_subagent_send` (parent-only)

```json
{
  "launchId": "lch_...",
  "message": "Now run the integration tests and report results.",
  "awaitReply": false,
  "awaitReplyTimeoutMs": 300000
}
```

Returns:

```json
{
  "ok": true,
  "delivered": true,
  "paneId": "pane:5",
  "reply": null
}
```

When `awaitReply: true` and a ping arrives within timeout:

```json
{
  "ok": true,
  "delivered": true,
  "paneId": "pane:5",
  "reply": { "message": "Tests pass: 47/47.", "writtenAt": "2026-04-26T03:14:15Z", "cursor": 1842 }
}
```

Errors: `LAUNCH_NOT_FOUND`, `PANE_DEAD`, `BACKEND_UNAVAILABLE`, `AWAIT_REPLY_TIMEOUT`, `INVALID_MESSAGE` (empty or > 64 KiB).

`AWAIT_REPLY_TIMEOUT` means **the message was delivered successfully but no reply ping arrived within `awaitReplyTimeoutMs`**. Do not retry the send — the child has already received the prompt. Either re-poll for the reply later via `_read_messages`, or accept that the child is taking longer than expected. The error response includes `delivered: true` to make this explicit:

```json
{ "ok": false, "error": "AWAIT_REPLY_TIMEOUT", "delivered": true, "paneId": "pane:5" }
```

**Multi-line messages:** the message body is wrapped in bracketed-paste escape sequences (`ESC [ 200 ~` … `ESC [ 201 ~`) before mux send-keys / write-chars. The child REPL sees the entire block as one paste plus one submit, so embedded `\n` does not split the prompt. Bracketed paste is forwarded unchanged by both tmux and zellij.

**`awaitReply` semantics:** when `awaitReply: true`, the extension captures `sendStartedCursor` = current byte size of `pings.jsonl` **immediately before** issuing the mux send. It then polls `readPingsSince(sendStartedCursor)` and returns the **first** record that appears. This guarantees backlog (records that already existed before send) is never mistaken for the reply, even when `manifest.messageCursor` is stale. Any unrelated proactive ping the child writes during the window is still treated as the reply (no per-message correlation). On success the reply is **consumed**: `manifest.messageCursor` is advanced to `reply.cursor` so a subsequent `_read_messages()` does not re-deliver the same record. For strict request/response correlation across many in-flight sends, prefer fire-and-forget + manual `_read_messages`.

**`send` when child is mid-tool:** if the child has spawned a tool that owns stdin (an interactive prompt), keystrokes land in the tool's stdin instead of the REPL queue. The extension does not detect this; documented as a known foot-gun consistent with the no-idle-detection decision.

### `copilot_subagent_message` (child-only)

```json
{ "message": "Tests pass: 47/47. Continuing to step 3." }
```

Returns: `{ "ok": true, "writtenAt": "2026-04-26T03:14:15Z" }`.

**Constraints:**
- `message` length ≤ 64 KiB and non-empty after trim (validated at the schema layer; rejection returns `INVALID_MESSAGE` before any file I/O). Cap exists to bound memory and prevent disk fill, not for write atomicity.
- Newlines inside `message` are JSON-escaped string data; they round-trip cleanly via `pings.jsonl`. (Unlike `_send`, no bracketed-paste handling is needed — `_message` does not type into a REPL.)
- Distinct from `caller_ping`: `_message` is in-flight communication; child does NOT exit. `caller_ping` is a lifecycle event; child returns from its turn and copilot exits.

Errors: `INVALID_MESSAGE` (empty or > 64 KiB), `MISSING_LAUNCH_CONTEXT` (tool invoked outside a child env — `COPILOT_SUBAGENT_LAUNCH_ID` unset), `SIDECAR_WRITE_FAILED` (filesystem error appending to `pings.jsonl`).

### `copilot_subagent_read_messages` (parent-only)

```json
{ "launchId": "lch_...", "sinceCursor": 1024 }
```

Returns:

```json
{
  "messages": [
    { "type": "message", "message": "...", "writtenAt": "...", "cursor": 1200 },
    { "type": "message", "message": "...", "writtenAt": "...", "cursor": 1842 }
  ],
  "nextCursor": 1842,
  "hasMore": false
}
```

`sinceCursor` is the byte offset of the last record consumed. **When omitted**, the reader uses the current `manifest.messageCursor` — i.e. "give me what I haven't seen since my last read or since `_send(awaitReply:true)` consumed something." Pass `sinceCursor: 0` explicitly to replay from the start. After a successful read, `manifest.messageCursor` is advanced to `nextCursor` so the next omitted-cursor call resumes from the right place.

Errors: `LAUNCH_NOT_FOUND`, `INVALID_CURSOR` (negative or non-integer), `SIDECAR_READ_FAILED` (filesystem error reading `pings.jsonl`).

## Sidecar Protocol

`<stateDir>/pings/<launchId>.jsonl` — append-only, one JSON record per line:

```
{"version":1,"type":"message","launchId":"lch_...","message":"...","writtenAt":"2026-04-26T03:14:15Z"}
{"version":1,"type":"message","launchId":"lch_...","message":"...","writtenAt":"2026-04-26T03:14:18Z"}
```

- **Writer:** `lib/ping-sidecar.mjs#appendPing` — opens with `O_APPEND`, single `write()` of `JSON.stringify(record) + "\n"`. On a local filesystem the kernel serializes appends via the inode lock, so concurrent single `write()` calls do not interleave regardless of size. The 64 KiB per-message cap (enforced at the schema layer) exists to bound memory and disk usage, not for atomicity.
- **Reader:** `lib/ping-sidecar.mjs#readPingsSince(launchId, cursor)` — opens read-only, `pread` from cursor, parses line-by-line, returns records + new cursor. Reader is **partial-line tolerant**: if the trailing line lacks `\n` or fails `JSON.parse`, it is skipped and the response sets `hasMore: true`; `nextCursor` advances only past records that were fully parsed. The skipped tail completes on a subsequent call once the writer flushes the rest of the line.
- **Forward-compat on `version`:** if a record has `version > 1`, the reader skips it and logs a warning to stderr; it does not throw or abort the batch. Lets a future writer add fields additively without poisoning older readers.
- **Cursor advance write race:** `_read_messages` updates `manifest.messageCursor` via the existing read-modify-write pattern used for `status`. No new locking; same race window, same mitigation (no concurrent readers per launch in practice).
- **No deletion in v2.1.** No retention sweep exists today (verified — no cleanup pass over `<stateDir>/` in the current codebase). `pings.jsonl` accumulates for the lifetime of the launch state directory along with the existing manifest and exit sidecar. Disk usage is bounded by the per-message 64 KiB cap × number of messages per launch; typical sessions are well under 1 MB. A general state-dir retention sweep is deferred to a future version and would clean exit sidecars, ping sidecars, and stale manifests together.

## Worker Pool Pattern (informational)

With these primitives a parent can implement a warm worker pool entirely in agent logic:

```
1. Launch N interactive children once at start of work. Record launchIds.
2. For each task in queue:
   a. Pick the first idle launchId (parent tracks busy/idle in its own state).
   b. copilot_subagent_send(launchId, taskPrompt, awaitReply: true).
   c. On reply, mark idle, store result.
3. When done, copilot_subagent_send(launchId, "Wrap up.") to each, expecting subagent_done.
```

v2.2 will add `copilot_subagent_list_active({tag})` and a manifest `tag` field to formalize discovery; v2.1 leaves bookkeeping to the agent.

## What Changes

### Public tool surface — additive only
Three new tools registered (`copilot_subagent_send`, `copilot_subagent_read_messages`, `copilot_subagent_message`). No existing tool signature, return shape, or error code changes. Existing `subagent_done` / `caller_ping` / `resume` semantics unchanged.

### Manifest schema — hard cutover, observable break
`METADATA_VERSION` bumps from 3 to 4. New required field `messageCursor: 0` on every record produced by `createLaunchRecord`. Per the existing v3 hard-cutover precedent (`lib/state.mjs:13` rejects any version that isn't current `METADATA_VERSION`), this means:

- A **v2.1 parent reading a v2.0-written manifest** → throws.
- A **v2.0 parent reading a v2.1-written manifest** → throws.
- Any **in-flight v2.0 parent process at deploy time** loses access to its existing launches; user must restart the parent.

This matches the v3 cutover precedent that landed without migration. Acceptable for the single-user blast radius (locked decision).

### Child environment — preamble grows
`CHILD_LIFECYCLE_PROMPT` gains one paragraph documenting `copilot_subagent_message`. Tests asserting exact preamble content (`test/unit/lifecycle-preamble.test.mjs`) must be updated.

### Filesystem layout — new sibling directory
New directory `<stateDir>/pings/` alongside the existing `<stateDir>/exit/`. No collision; both are append-only sidecars with parallel semantics.

### Tool access control — `_send` and `_read_messages` join the gated set
`PUBLIC_SPAWNING_TOOL_NAMES` (or equivalent gating set in `lib/tool-schemas.mjs`) gains `copilot_subagent_send` and `copilot_subagent_read_messages` so children cannot orchestrate other children. `copilot_subagent_message` is the inverse — explicitly child-exposed, parent-hidden.

## Out of scope

- Daemon / persistent socket between parent and child.
- Channel multiplexing (separate streams for logs, status, chat).
- Idle detection / readiness probes.
- Replacing or deprecating `resume`.
- Multi-parent fan-in to a single child.
- Worker-pool helpers (`list_active`, manifest `tag`/`role`).
