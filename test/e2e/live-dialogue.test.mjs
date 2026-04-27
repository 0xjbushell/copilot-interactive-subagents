/**
 * E2E live-dialogue tests — exercises dialogue pure functions with real file I/O.
 *
 * Tests the dialogue flow by creating real workspaces, writing real pings.jsonl
 * entries, and verifying cursor management and message ordering through the
 * readMessages / sendMessage APIs with injected services.
 *
 * Run: node --test test/e2e/live-dialogue.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { readMessages } from "../../packages/copilot-interactive-subagents/extension/lib/read-messages.mjs";
import { sendMessage } from "../../packages/copilot-interactive-subagents/extension/lib/send.mjs";
import { appendPing, readPingsSince } from "../../packages/copilot-interactive-subagents/extension/lib/ping-sidecar.mjs";
import { createStateStore } from "../../packages/copilot-interactive-subagents/extension/lib/state.mjs";

const LAUNCH_ID = "dialogue-test-001";

async function createWorkspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dialogue-e2e-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function seedManifest(workspacePath, overrides = {}) {
  const store = createStateStore({ workspacePath });
  const record = {
    launchId: LAUNCH_ID,
    agentIdentifier: "github-copilot",
    agentKind: "copilot",
    backend: "tmux",
    paneId: "%5",
    requestedAt: new Date().toISOString(),
    status: "running",
    copilotSessionId: "session-uuid-test",
    messageCursor: 0,
    ...overrides,
  };
  await store.writeLaunchRecord(record);
  return store;
}

function stateDir(workspacePath) {
  return path.join(workspacePath, ".copilot-interactive-subagents");
}

describe("live-dialogue", () => {
  // ----- Scenario 1: Full dialogue flow -----------------------------------

  it("full dialogue flow: append pings → read → cursor advances → append more → read new only", async (t) => {
    const workspacePath = await createWorkspace(t);
    const store = await seedManifest(workspacePath);
    const sd = stateDir(workspacePath);

    // Append two pings
    appendPing({ stateDir: sd, launchId: LAUNCH_ID, message: "msg-1" });
    appendPing({ stateDir: sd, launchId: LAUNCH_ID, message: "msg-2" });

    // Read all messages (no prior cursor)
    const result1 = await readMessages({
      launchId: LAUNCH_ID,
      services: {
        readLaunchRecord: (id) => store.readLaunchRecord(id),
        updateLaunchRecord: (id, u) => store.updateLaunchRecord(id, u),
        readPingsSince: (opts) => readPingsSince(opts),
        stateDir: sd,
      },
    });

    assert.equal(result1.ok, true);
    assert.equal(result1.messages.length, 2);
    assert.equal(result1.messages[0].message, "msg-1");
    assert.equal(result1.messages[1].message, "msg-2");
    const cursor1 = result1.nextCursor;
    assert.ok(cursor1 > 0, "Cursor should advance past zero");

    // Append one more ping
    appendPing({ stateDir: sd, launchId: LAUNCH_ID, message: "msg-3" });

    // Read again — should only return msg-3 (cursor was persisted)
    const result2 = await readMessages({
      launchId: LAUNCH_ID,
      services: {
        readLaunchRecord: (id) => store.readLaunchRecord(id),
        updateLaunchRecord: (id, u) => store.updateLaunchRecord(id, u),
        readPingsSince: (opts) => readPingsSince(opts),
        stateDir: sd,
      },
    });

    assert.equal(result2.ok, true);
    assert.equal(result2.messages.length, 1);
    assert.equal(result2.messages[0].message, "msg-3");
    assert.ok(result2.nextCursor > cursor1, "Cursor should advance further");
  });

  // ----- Scenario 2: Send with awaitReply ---------------------------------

  it("send with awaitReply returns reply when child responds", async (t) => {
    const workspacePath = await createWorkspace(t);
    const store = await seedManifest(workspacePath);
    const sd = stateDir(workspacePath);

    // Pre-write a ping so readPingsSince returns it as a reply
    appendPing({ stateDir: sd, launchId: LAUNCH_ID, message: "reply-from-child" });

    const result = await sendMessage({
      launchId: LAUNCH_ID,
      message: "What status?",
      awaitReply: true,
      awaitReplyTimeoutMs: 5000,
      services: {
        readLaunchRecord: (id) => store.readLaunchRecord(id),
        updateLaunchRecord: (id, u) => store.updateLaunchRecord(id, u),
        probeBackendAvailable: async () => true,
        probeSessionLiveness: () => true,
        runBackendSendKeys: async () => {},
        getPingsFileSize: () => 0,
        readPingsSince: (opts) => readPingsSince(opts),
        stateDir: sd,
        now: () => Date.now(),
        sleep: async () => {},
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.delivered, true);
    assert.equal(result.paneId, "%5");
    assert.ok(result.reply, "Should have a reply");
    assert.equal(result.reply.message, "reply-from-child");
    assert.ok(result.reply.cursor > 0);
  });

  // ----- Scenario 3: Send awaitReply timeout ------------------------------

  it("send with awaitReply times out when no child response", async (t) => {
    const workspacePath = await createWorkspace(t);
    const store = await seedManifest(workspacePath);

    // No pings written — readPingsSince will return empty
    let callCount = 0;
    const result = await sendMessage({
      launchId: LAUNCH_ID,
      message: "Hello?",
      awaitReply: true,
      awaitReplyTimeoutMs: 50,
      services: {
        readLaunchRecord: (id) => store.readLaunchRecord(id),
        updateLaunchRecord: (id, u) => store.updateLaunchRecord(id, u),
        probeBackendAvailable: async () => true,
        probeSessionLiveness: () => true,
        runBackendSendKeys: async () => {},
        getPingsFileSize: () => 0,
        readPingsSince: () => ({ records: [], nextCursor: 0, hasMore: false }),
        stateDir: stateDir(workspacePath),
        now: (() => {
          let t = Date.now();
          return () => {
            // First call returns base time, subsequent calls jump past deadline
            callCount++;
            return callCount <= 1 ? t : t + 100;
          };
        })(),
        sleep: async () => {},
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "AWAIT_REPLY_TIMEOUT");
    assert.equal(result.delivered, true);
  });

  // ----- Scenario 4: Message ordering preserved ---------------------------

  it("message ordering is preserved across multiple appends and reads", async (t) => {
    const workspacePath = await createWorkspace(t);
    const store = await seedManifest(workspacePath);
    const sd = stateDir(workspacePath);

    const messages = ["alpha", "bravo", "charlie"];
    for (const msg of messages) {
      appendPing({ stateDir: sd, launchId: LAUNCH_ID, message: msg });
    }

    const result = await readMessages({
      launchId: LAUNCH_ID,
      services: {
        readLaunchRecord: (id) => store.readLaunchRecord(id),
        updateLaunchRecord: (id, u) => store.updateLaunchRecord(id, u),
        readPingsSince: (opts) => readPingsSince(opts),
        stateDir: sd,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.messages.length, 3);
    assert.deepStrictEqual(
      result.messages.map((m) => m.message),
      messages,
    );

    // Verify cursors are monotonically increasing
    for (let i = 1; i < result.messages.length; i++) {
      assert.ok(
        result.messages[i].cursor > result.messages[i - 1].cursor,
        `Cursor at index ${i} should be greater than cursor at index ${i - 1}`,
      );
    }
  });
});
