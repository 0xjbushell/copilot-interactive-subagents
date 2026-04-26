# Feature: interactive-subagents-v2.1 — Decisions

## Feature Boundary

v2.1 adds **live, multi-turn conversation between parent and child** without requiring the child to exit between turns. v2.0's RPC-style loop (`launch` → child runs → `subagent_done`/`caller_ping` exit → `resume` in fresh pane) is unchanged and remains the right primitive for cold restart of dead sessions. v2.1 is purely additive.

The new model treats a child copilot REPL as a **long-lived worker** that can receive new prompts on its existing pane via mux `send-keys`/`write-chars`. The child reciprocates with non-exiting ping messages written to an append-only sidecar. The combination unlocks:

1. **Continuous dialogue** — parent and child trade turns without the per-turn cost of spinning up a new copilot process.
2. **Warm worker pools** — a parent keeps N children alive and dispatches tasks to whichever is idle, eliminating cold-start latency for parallel work.
3. **Specialized long-lived agents** — `architect`, `tester`, `reviewer` workers that retain context across many tasks.

Out of scope for v2.1:
- Idle detection / readiness probes — copilot's REPL queues input, so `send` is fire-and-forget.
- Worker-pool helpers (`list_active(filter)`, manifest `tag` field) — deferred to v2.2.
- Channel multiplexing (logs/status/chat on separate streams) — sidecar stays a single append-only log.
- Replacing or deprecating `resume` — it remains the cold-restart primitive.

## Decisions (locked)

- **Parent → live child transport** → **A. Mux `send-keys` to existing pane** `high` — Reuse the same mechanism a human uses when they type into the child's pane in interactive mode. New tool `copilot_subagent_send(launchId, message, awaitReply?)` looks up `paneId` from the manifest and issues `tmux send-keys -t <pane> "<message>" Enter` / `zellij action write-chars --pane-id <pane> "<message>\n"`. No new IPC layer, no stdin proxy, no daemon. Pane death is the failure mode; sending into a queued REPL is safe because copilot CLI buffers input.

- **Idle/readiness detection** → **A. None — fire and forget** `high` — Copilot's REPL already queues prompts that arrive while it's mid-response. `send` does not probe pane state; the only pre-flight check is that the pane still exists. This eliminates an entire class of timing complexity. Documented behavior: messages are processed in arrival order; the parent should not assume immediate response.

- **Child → live parent transport** → **A. Append-only `pings.jsonl` sidecar** `high` — New file at `<stateDir>/pings/<launchId>.jsonl`, separate from the existing exit sidecar (`<stateDir>/exit/<launchId>.json`). Each line is a JSON record `{version: 1, type: "message", launchId, message, writtenAt}`. Append-only so the parent can tail/poll without coordination. Existing exit sidecar semantics unchanged: it is still a single-shot terminal record written by `subagent_done` or `caller_ping`.

- **Non-exiting child message tool** → **B. New tool `copilot_subagent_message`** `medium` — Add a sibling tool to `caller_ping` rather than overload `caller_ping` with a `keepAlive` flag. Rationale: `caller_ping` is a **lifecycle event** (child finishing this run, asking parent to resume); `message` is an **in-flight communication** (child sending a note while still working). Distinct semantics → distinct tools. Gating: `copilot_subagent_message` is exposed to children alongside `subagent_done` + `caller_ping`. Implementation: writes one record to `pings.jsonl`, returns success immediately, child continues its turn.

- **`send` reply mode** → **A. Optional `awaitReply` flag** `high` — `copilot_subagent_send(launchId, message)` returns immediately by default. With `awaitReply: true`, the extension polls `pings.jsonl` for the **first new record with `writtenAt > sendStartedAt`** (timeout configurable, default 5 minutes). This is sugar over send + poll; the parent can also choose to send fire-and-forget and read pings on its own next turn via a separate `copilot_subagent_read_messages(launchId, sinceCursor?)` tool (see next decision).

- **Reading pings on demand** → **A. New tool `copilot_subagent_read_messages`** `high` — Parent reads new ping records via `copilot_subagent_read_messages(launchId, sinceCursor?)`. Returns `{messages: [...], nextCursor}`. Cursor is the byte offset or last `writtenAt` (impl choice). Without this tool the parent would have no way to consume async messages outside the `awaitReply` synchronous path. Excluded from children via the same gating as other public tools.

- **Pane lifetime across messages** → **A. Pane stays open until `subagent_done` OR pane death** `high` — `caller_ping` already keeps the pane open in interactive mode (child REPL persists; copilot exits only when the model ends its turn). `copilot_subagent_message` does not exit the child at all. The pane only closes on `subagent_done` (existing self-close path), pane crash, or explicit user close. `closePaneOnCompletion` is unaffected — it still fires only on terminal exit, not on each message exchange.

- **Interactive mode required for live dialogue** → **B. Strongly recommend, do not enforce** `medium` — Live dialogue only works if the child copilot REPL stays alive between turns, which means `interactive: true`. In autonomous (`-p`) mode the child exits after one turn and `send` will fail with `PANE_DEAD`. Documentation makes this explicit; we do not refuse `send` on autonomous launches at the schema level (the runtime check is sufficient and gives a clear error).

- **Backward compatibility** → **A. Strictly additive — no breaking changes** `high` — All v2.0 flows (`launch`/`parallel`/`resume`/`subagent_done`/`caller_ping`/sidecar protocol) work unchanged. New tools are additive: `copilot_subagent_send`, `copilot_subagent_read_messages`, `copilot_subagent_message`. New file (`pings.jsonl`) is created lazily on first message. Manifest schema bumps to v4 with optional `messageHistory` summary field; v3 manifests are forward-compatible (missing field treated as empty).

- **Worker-pool helpers** → **DEFER to v2.2** `low` — `copilot_subagent_list_active({tag, role, status})` and a `tag`/`role` field on launch manifests would let parents discover idle workers without manually tracking launch IDs. Out of scope for v2.1 to keep the surface tight; v2.1 ships the conversation primitives, v2.2 ships the orchestration sugar on top.

- **Tool access control for children** → **A. Same exclusion list as v2 + add `_send` and `_read_messages`** `high` — Children must not be able to spawn or message other children. Add `copilot_subagent_send` and `copilot_subagent_read_messages` to the v2 exclusion catalog (`lib/tool-schemas.mjs#PUBLIC_TOOL_NAMES` + camelCase aliases). Children retain only `subagent_done`, `caller_ping`, and the new `copilot_subagent_message`.

## Open questions (not blocking)

- Should `pings.jsonl` rotate or compact? At 1 KB/message and typical session lifetimes this is a non-issue; defer.
- Should `send` accept a list of messages for batched fan-out? No — caller can call `send` N times; the per-call cost is a single mux write.
- Cursor format for `read_messages` — byte offset (cheap, robust) vs. ISO timestamp (human-readable, requires monotonicity). Lean byte offset; lock during implementation.
