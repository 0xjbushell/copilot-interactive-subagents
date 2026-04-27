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

- **Parent → live child transport** → **A. Mux `send-keys` to existing pane** `high` — Reuse the same mechanism a human uses when they type into the child's pane in interactive mode. New tool `copilot_subagent_send(launchId, message, awaitReply?)` looks up `paneId` from the manifest and issues `tmux send-keys -t <pane> "<wrapped>" Enter` / `zellij action write-chars --pane-id <pane> "<wrapped>\n"`, where `<wrapped>` is the message body wrapped in bracketed-paste escape sequences (see "Multi-line messages over `_send`" decision below). No new IPC layer, no stdin proxy, no daemon. Pane death is the failure mode; sending into a queued REPL is safe because copilot CLI buffers input.

- **Idle/readiness detection** → **A. None — fire and forget** `high` — Copilot's REPL already queues prompts that arrive while it's mid-response. `send` does not probe pane state; the only pre-flight check is that the pane still exists. This eliminates an entire class of timing complexity. Documented behavior: messages are processed in arrival order; the parent should not assume immediate response.

- **Child → live parent transport** → **A. Append-only `pings.jsonl` sidecar** `high` — New file at `<stateDir>/pings/<launchId>.jsonl`, separate from the existing exit sidecar (`<stateDir>/exit/<launchId>.json`). Each line is a JSON record `{version: 1, type: "message", launchId, message, writtenAt}`. Append-only so the parent can tail/poll without coordination. Existing exit sidecar semantics unchanged: it is still a single-shot terminal record written by `subagent_done` or `caller_ping`.

- **Non-exiting child message tool** → **B. New tool `copilot_subagent_message`** `medium` — Add a sibling tool to `caller_ping` rather than overload `caller_ping` with a `keepAlive` flag. Rationale: `caller_ping` is a **lifecycle event** (child finishing this run, asking parent to resume); `message` is an **in-flight communication** (child sending a note while still working). Distinct semantics → distinct tools. Gating: `copilot_subagent_message` is exposed to children alongside `subagent_done` + `caller_ping`. Implementation: writes one record to `pings.jsonl`, returns success immediately, child continues its turn.

- **`send` reply mode** → **A. Optional `awaitReply` flag, consumes the reply** `high` — `copilot_subagent_send(launchId, message)` returns immediately by default. With `awaitReply: true`, the extension captures `sendStartedCursor` = byte size of `pings.jsonl` immediately before the mux send, then polls `readPingsSince(sendStartedCursor)` for the **first new record** (timeout configurable, default 5 minutes). When a reply is captured, `_send` advances `manifest.messageCursor` to the reply's cursor — the reply is **consumed**, not peeked. This means a subsequent `_read_messages()` (with `sinceCursor` omitted) starts after the reply, eliminating duplicate-delivery footguns. Callers who want to replay can pass an explicit `sinceCursor`.

- **Reading pings on demand** → **A. New tool `copilot_subagent_read_messages`** `high` — Parent reads new ping records via `copilot_subagent_read_messages(launchId, sinceCursor?)`. Returns `{messages: [...], nextCursor, hasMore}`. Cursor is a byte offset (per the locked "Cursor format" decision below). When `sinceCursor` is omitted, the reader uses the current `manifest.messageCursor` ("give me what I haven't seen"); pass an explicit `sinceCursor: 0` to replay everything. After a successful read, `manifest.messageCursor` is advanced to `nextCursor`. Excluded from children via the gating set (`PUBLIC_SPAWNING_TOOL_NAMES`).

- **Pane lifetime across messages** → **A. Pane stays open until `subagent_done` OR pane death** `high` — `caller_ping` already keeps the pane open in interactive mode (child REPL persists; copilot exits only when the model ends its turn). `copilot_subagent_message` does not exit the child at all. The pane only closes on `subagent_done` (existing self-close path), pane crash, or explicit user close. `closePaneOnCompletion` is unaffected — it still fires only on terminal exit, not on each message exchange.

- **Interactive mode required for live dialogue** → **B. Strongly recommend, do not enforce** `medium` — Live dialogue only works if the child copilot REPL stays alive between turns, which means `interactive: true`. In autonomous (`-p`) mode the child exits after one turn and `send` will fail with `PANE_DEAD`. Documentation makes this explicit; we do not refuse `send` on autonomous launches at the schema level (the runtime check is sufficient and gives a clear error).

- **Backward compatibility** → **A. Strictly additive at the public-tool surface; hard cutover on manifest version** `high` — All v2.0 tool flows (`launch`/`parallel`/`resume`/`subagent_done`/`caller_ping`/sidecar protocol) work unchanged. New tools are additive: `copilot_subagent_send`, `copilot_subagent_read_messages`, `copilot_subagent_message`. New file (`pings.jsonl`) is created lazily on first message. Manifest schema bumps to v4 (adds `messageCursor: 0` field); per existing v3 precedent (`lib/state.mjs:13`), older parents reject v4 manifests and vice versa. Single-user project, acceptable.

- **Cursor format for `read_messages`** → **A. Byte offset** `high` — Resolves the open question from v2.1 design. Cursor is a non-negative integer byte offset into `pings.jsonl`. `readPingsSince(offset)` issues `fs.read(fd, buf, 0, len, offset)` and parses forward. Cheap (no whole-file scan), monotonic, immune to clock skew between parent and child, matches the `tail -f` / Kafka-consumer pattern this implements. Persisted on the manifest as `messageCursor`.

- **Message length cap** → **A. 64 KiB per message** `high` — Hard cap enforced in the `copilot_subagent_message` schema validator. Rationale: not for write atomicity (single `write()` with `O_APPEND` on a local filesystem doesn't interleave regardless of size — `PIPE_BUF` only governs pipes), but to bound memory and prevent a runaway child from filling disk. 64 KiB is well above realistic prompt lengths (typical 2–10 KiB). Reader is **partial-line-tolerant**: if the last line lacks `\n` or fails `JSON.parse`, skip it and return `hasMore: true`; complete on next call.

- **Worker-pool helpers** → **DEFER to v2.2** `low` — `copilot_subagent_list_active({tag, role, status})` and a `tag`/`role` field on launch manifests would let parents discover idle workers without manually tracking launch IDs. Out of scope for v2.1 to keep the surface tight; v2.1 ships the conversation primitives, v2.2 ships the orchestration sugar on top.

- **Tool access control for children** → **A. Same exclusion mechanism as v2 + add `_send` and `_read_messages` to `PUBLIC_SPAWNING_TOOL_NAMES`** `high` — Children must not be able to spawn or message other children. Add `copilot_subagent_send` and `copilot_subagent_read_messages` to `PUBLIC_SPAWNING_TOOL_NAMES` in `lib/tool-schemas.mjs` (the gating set used by the v2 child exclusion path). They are also registered in `PUBLIC_TOOL_NAMES` and aliased in `CAMELCASE_HANDLER_NAMES` like every other public tool. Children retain only `subagent_done`, `caller_ping`, and the new `copilot_subagent_message`.

- **`awaitReply` reply matching** → **A. Imprecise — first ping appended after `sendStartedCursor`** `medium` — `_send({awaitReply:true})` captures the byte size of `pings.jsonl` immediately before the mux send (`sendStartedCursor`) and returns the first record appended past that offset. This guarantees pre-existing backlog is never mistaken for the reply, regardless of `manifest.messageCursor` state. Still imprecise to caller noise: any unrelated proactive ping the child writes during the window is treated as the reply. Documented as a caller foot-gun. Callers needing serious request/response correlation should fire-and-forget then call `_read_messages` and pick the matching record themselves. Avoids inventing a correlation-ID protocol for v2.1; revisit only if the imprecision causes real bugs.

- **Multi-line messages over `_send`** → **B. Bracketed paste** `high` — Parent messages may contain embedded `\n`. A naïve `tmux send-keys -- "msg" Enter` would treat each `\n` as a REPL submission, splitting one prompt into N. `_send` wraps the message in bracketed-paste escape sequences (`ESC [ 200 ~` … `ESC [ 201 ~`) before send-keys / write-chars, so the REPL sees the entire multi-line block as a single paste followed by one submit. Both tmux and zellij forward bracketed-paste sequences unchanged. Single-line messages get the same wrapping; the cost is two extra escape sequences. (`_message` is unaffected — newlines inside the `message` JSON field are just escaped string data.)

- **Send when child is mid-tool / stdin-attached** → **A. Document as foot-gun, no detection** `medium` — If the child copilot process has spawned a tool that owns stdin (e.g. an interactive prompt), `send-keys` lands in the *tool's* stdin, not copilot's REPL queue. We do not attempt to detect this. Consistent with the locked "no idle detection" decision (`send` is fire-and-forget). Documented in skill docs and `_send` tool description.

- **Empty / oversized message rejection** → **A. Schema-layer validation** `high` — `_message` rejects `message: ""` (empty after trim) and `message.length > 64 KiB` before any file I/O, returning a clear validation error. `_send` applies the same rules so a doomed send is caught before mux invocation.

- **Forward compat on `pings.jsonl` record `version`** → **A. Skip with warning** `medium` — If `readPingsSince` encounters a record with `version > 1`, it skips the record and logs a warning to stderr (does not throw, does not abort the batch). Keeps a future writer additive — old readers degrade gracefully instead of poisoning the parent's read loop.

- **`messageCursor` manifest write race** → **A. Reuse existing manifest read-modify-write pattern** `high` — `_read_messages` advances `messageCursor` by reading the manifest, updating the field, writing it back. This is the same atomicity model the existing `status` updates already use; same race window, same mitigation (no concurrent readers per launch in practice). No new locking primitive introduced.

## Open questions (not blocking)

- Should `pings.jsonl` rotate or compact? At 1 KB/message and typical session lifetimes this is a non-issue; defer.
- Should `send` accept a list of messages for batched fan-out? No — caller can call `send` N times; the per-call cost is a single mux write.
