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
| Mux send-keys | `lib/mux.mjs` / `lib/backend-ops.mjs` | `sendKeys` (tmux), `writeChars` (zellij) | Existing helpers used by interactive mode; reuse |
| Pane liveness probe | `lib/resume.mjs` | `defaultProbeSessionLiveness` (line 280) | Reuse for `send` pre-flight |
| Manifest CRUD | `lib/state.mjs` | `METADATA_VERSION`, `createLaunchRecord`, `readLaunchRecord` | Bump to v4; add `messageCursor` field |
| Exit sidecar (existing) | `lib/exit-sidecar.mjs` | writer + reader | Unchanged in v2.1 |
| Ping sidecar (new) | `lib/ping-sidecar.mjs` (**new**) | append + tail | Append-only JSONL, separate file from exit sidecar |
| Tool catalog | `lib/tool-schemas.mjs` | `PUBLIC_TOOL_NAMES` (line 7-12), `TOOL_NAME_ALIASES` (line 218-223) | Add `_send` + `_read_messages` to gated set |
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
- `awaitReply: true` returns the first ping record with `writtenAt > sendStartedAt`; times out cleanly if none arrives.
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

Errors: `LAUNCH_NOT_FOUND`, `PANE_DEAD`, `BACKEND_UNAVAILABLE`, `AWAIT_REPLY_TIMEOUT`.

### `copilot_subagent_message` (child-only)

```json
{ "message": "Tests pass: 47/47. Continuing to step 3." }
```

Returns: `{ "ok": true, "writtenAt": "2026-04-26T03:14:15Z" }`.

Distinct from `caller_ping`: `_message` is in-flight communication; child does NOT exit. `caller_ping` is a lifecycle event; child returns from its turn and copilot exits.

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

`sinceCursor` is the byte offset returned by the previous call (or 0 / omitted for first read).

## Sidecar Protocol

`<stateDir>/pings/<launchId>.jsonl` — append-only, one JSON record per line:

```
{"version":1,"type":"message","launchId":"lch_...","message":"...","writtenAt":"2026-04-26T03:14:15Z"}
{"version":1,"type":"message","launchId":"lch_...","message":"...","writtenAt":"2026-04-26T03:14:18Z"}
```

- **Writer:** `lib/ping-sidecar.mjs#appendPing` — opens with `O_APPEND`, single `write()` of `JSON.stringify(record) + "\n"`. Atomicity guaranteed by POSIX `O_APPEND` for writes < `PIPE_BUF`.
- **Reader:** `lib/ping-sidecar.mjs#readPingsSince(launchId, cursor)` — opens read-only, `pread` from cursor, parses line-by-line, returns records + new cursor (current EOF).
- **No deletion.** File persists for the lifetime of the launch state directory and is removed by the same retention sweep that handles exit sidecars.

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

## Out of scope

- Daemon / persistent socket between parent and child.
- Channel multiplexing (separate streams for logs, status, chat).
- Idle detection / readiness probes.
- Replacing or deprecating `resume`.
- Multi-parent fan-in to a single child.
- Worker-pool helpers (`list_active`, manifest `tag`/`role`).
