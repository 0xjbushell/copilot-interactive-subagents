/**
 * Live dialogue E2E — tests parent-side dialogue plumbing with real tmux panes.
 *
 * These tests verify the full send/read/awaitReply plumbing against real
 * tmux panes and real file I/O. Scenarios 2 & 3 use raw `cat` panes
 * (not copilot) so current_command is never a DEAD_SHELL during startup.
 *
 * Run: node --test --test-timeout=600000 test/e2e/live-dialogue-copilot.test.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import {
  preflight,
  createBackendDriver,
  createE2EHandlers,
  createE2EWorkspace,
  createNonce,
  sleep,
} from "./e2e-helpers.mjs";

import { appendPing } from "../../packages/copilot-interactive-subagents/extension/lib/ping-sidecar.mjs";

const execFile = promisify(execFileCb);

let capabilities;

before(async () => {
  capabilities = await preflight();
});

describe("tmux live dialogue (real copilot)", () => {
  let driver;
  let skipReason = null;

  before(async () => {
    if (!capabilities.copilot) {
      skipReason = "copilot CLI not available";
      return;
    }
    if (!capabilities.tmux) {
      skipReason = "tmux not available";
      return;
    }
    driver = createBackendDriver("tmux");
    await driver.setup();
  });

  after(async () => {
    if (driver) await driver.teardown();
  });

  function skipIfNeeded(t) {
    if (skipReason) {
      t.skip(skipReason);
      return true;
    }
    return false;
  }

  // --- Scenario 1: Parent reads messages written by simulated child --------

  it("parent reads messages from pings.jsonl written during child session", async (t) => {
    if (skipIfNeeded(t)) return;

    const workspacePath = await createE2EWorkspace(t);
    const nonce = createNonce();
    const { handlers, stateStore } = await createE2EHandlers({
      backend: "tmux",
      driver,
      workspacePath,
    });

    const result = await handlers.copilot_subagent_launch({
      workspacePath,
      requestedIdentifier: "github-copilot",
      task: `Say hello`,
      awaitCompletion: true,
      env: driver.env(),
    });

    assert.equal(result.ok, true, `Launch failed: ${JSON.stringify(result).slice(0, 500)}`);

    const stateDir = path.join(workspacePath, ".copilot-interactive-subagents");
    appendPing({ stateDir, launchId: result.launchId, message: nonce });

    const readResult = await handlers.copilot_subagent_read_messages({
      workspacePath,
      launchId: result.launchId,
    });

    assert.equal(readResult.ok, true, `read_messages failed: ${JSON.stringify(readResult).slice(0, 500)}`);
    assert.equal(readResult.messages.length, 1);
    assert.equal(readResult.messages[0].message, nonce);
    assert.ok(readResult.nextCursor > 0, "Cursor should advance");

    const manifest = await stateStore.readLaunchRecord(result.launchId);
    assert.equal(manifest.messageCursor, readResult.nextCursor);
  });

  // --- Scenario 2: Parent sends message to a live pane ---------------------
  // Uses a raw tmux pane running `cat` with a synthetic manifest so
  // probeSessionLiveness sees `cat` (not a DEAD_SHELL) immediately.

  it("parent sends message to child pane via send handler", async (t) => {
    if (skipIfNeeded(t)) return;

    const workspacePath = await createE2EWorkspace(t);
    const nonce = createNonce();
    const { handlers, stateStore } = await createE2EHandlers({
      backend: "tmux",
      driver,
      workspacePath,
    });

    // Open a raw pane running `cat` — blocks on stdin, reports as `cat`
    const { stdout: splitOut } = await execFile("tmux", [
      "split-window", "-t", driver.sessionName, "-d", "-P", "-F", "#{pane_id}",
      "cat",
    ]);
    const rawPaneId = splitOut.trim();
    t.after(async () => {
      try { await execFile("tmux", ["kill-pane", "-t", rawPaneId]); } catch { /* already gone */ }
    });

    // Create a synthetic manifest pointing at the raw pane
    const launchId = `send-test-${nonce}`;
    await stateStore.writeLaunchRecord({
      launchId,
      agentIdentifier: "test-agent",
      agentKind: "copilot",
      backend: "tmux",
      paneId: rawPaneId,
      requestedAt: new Date().toISOString(),
      status: "running",
    });

    const sendResult = await handlers.copilot_subagent_send({
      workspacePath,
      launchId,
      message: nonce,
      awaitReply: false,
    });

    assert.equal(sendResult.ok, true, `Send failed: ${JSON.stringify(sendResult)}`);
    assert.equal(sendResult.delivered, true);
    assert.equal(sendResult.paneId, rawPaneId);

    // Verify the message was actually delivered to the pane
    await sleep(500);
    const { stdout: paneContent } = await execFile("tmux", [
      "capture-pane", "-p", "-t", rawPaneId,
    ]);
    assert.ok(paneContent.includes(nonce), `Pane should contain the sent nonce: ${nonce}`);
  });

  // --- Scenario 3: Send with awaitReply + simulated child response ---------

  it("send with awaitReply receives simulated child response from pings.jsonl", async (t) => {
    if (skipIfNeeded(t)) return;

    const workspacePath = await createE2EWorkspace(t);
    const nonce = createNonce();
    const { handlers, stateStore } = await createE2EHandlers({
      backend: "tmux",
      driver,
      workspacePath,
    });

    // Open a raw pane running `cat`
    const { stdout: splitOut } = await execFile("tmux", [
      "split-window", "-t", driver.sessionName, "-d", "-P", "-F", "#{pane_id}",
      "cat",
    ]);
    const rawPaneId = splitOut.trim();
    t.after(async () => {
      try { await execFile("tmux", ["kill-pane", "-t", rawPaneId]); } catch { /* already gone */ }
    });

    const launchId = `reply-test-${nonce}`;
    await stateStore.writeLaunchRecord({
      launchId,
      agentIdentifier: "test-agent",
      agentKind: "copilot",
      backend: "tmux",
      paneId: rawPaneId,
      requestedAt: new Date().toISOString(),
      status: "running",
    });

    const stateDir = path.join(workspacePath, ".copilot-interactive-subagents");

    // Start send with awaitReply in background
    const sendPromise = handlers.copilot_subagent_send({
      workspacePath,
      launchId,
      message: "What status?",
      awaitReply: true,
      awaitReplyTimeoutMs: 30000,
    });

    // Simulate child writing a reply after a short delay
    await sleep(2000);
    appendPing({ stateDir, launchId, message: `reply-${nonce}` });

    const sendResult = await sendPromise;

    assert.equal(sendResult.ok, true, `Send failed: ${JSON.stringify(sendResult)}`);
    assert.equal(sendResult.delivered, true);
    assert.ok(sendResult.reply, "Should have a reply");
    assert.equal(sendResult.reply.message, `reply-${nonce}`);
    assert.ok(sendResult.reply.cursor > 0);
  });
});
