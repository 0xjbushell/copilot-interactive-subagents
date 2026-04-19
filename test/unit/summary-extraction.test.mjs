import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { importProjectModule } from "../helpers/red-harness.mjs";

const SUMMARY_MODULE = ".github/extensions/copilot-interactive-subagents/lib/summary.mjs";

async function loadWaiter() {
  const { waitForLaunchCompletion } = await importProjectModule(SUMMARY_MODULE, ["waitForLaunchCompletion"]);
  return waitForLaunchCompletion;
}

function makeSidecarServices(payloadByLaunchId) {
  return {
    existsSync: (filePath) => {
      const launchId = String(filePath).split(/[\\/]/).pop().replace(/\.json$/, "");
      return Object.prototype.hasOwnProperty.call(payloadByLaunchId, launchId);
    },
    readFileSync: (filePath) => {
      const launchId = String(filePath).split(/[\\/]/).pop().replace(/\.json$/, "");
      const payload = payloadByLaunchId[launchId];
      if (payload === undefined) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return typeof payload === "string" ? payload : JSON.stringify(payload);
    },
    warn: () => {},
  };
}

describe("waitForLaunchCompletion sidecar-first read (D2.2)", () => {
  it("AC1: returns sidecar-source completion when sidecar exists before sentinel", async () => {
    const waitForLaunchCompletion = await loadWaiter();
    const sidecarServices = makeSidecarServices({
      "lid-1": { version: 1, type: "done", launchId: "lid-1", exitCode: 0, summary: "all good", writtenAt: "2025-01-01T00:00:00Z" },
    });
    let paneCalls = 0;
    const result = await waitForLaunchCompletion({
      launchId: "lid-1",
      stateDir: "/tmp/state",
      backend: "tmux",
      paneId: "pane:1",
      agentIdentifier: "claude",
      readPaneOutput: async () => { paneCalls += 1; return { output: "" }; },
      sidecarServices,
      maxAttempts: 5,
      pollIntervalMs: 0,
      sleep: async () => {},
    });
    assert.equal(result.source, "sidecar");
    assert.equal(result.sidecarType, "done");
    assert.equal(result.summary, "all good");
    assert.equal(result.exitCode, 0);
    assert.equal(result.status, "success");
    assert.match(result.sidecarPath, /lid-1\.json$/);
  });

  it("AC2: ping sidecar yields source=sidecar with sidecarType=ping and message", async () => {
    const waitForLaunchCompletion = await loadWaiter();
    const sidecarServices = makeSidecarServices({
      "lid-2": { version: 1, type: "ping", launchId: "lid-2", message: "need clarification", writtenAt: "2025-01-01T00:00:00Z" },
    });
    const result = await waitForLaunchCompletion({
      launchId: "lid-2", stateDir: "/tmp/state",
      backend: "tmux", paneId: "pane:1", agentIdentifier: "claude",
      readPaneOutput: async () => ({ output: "" }),
      sidecarServices, maxAttempts: 3, pollIntervalMs: 0,
      sleep: async () => {},
    });
    assert.equal(result.source, "sidecar");
    assert.equal(result.sidecarType, "ping");
    assert.equal(result.message, "need clarification");
    assert.equal(result.status, "ping");
  });

  it("AC3: sentinel without sidecar returns source=sentinel after grace window", async () => {
    const waitForLaunchCompletion = await loadWaiter();
    const sidecarServices = makeSidecarServices({});
    const sleeps = [];
    const result = await waitForLaunchCompletion({
      launchId: "lid-3", stateDir: "/tmp/state",
      backend: "tmux", paneId: "pane:1", agentIdentifier: "claude",
      readPaneOutput: async () => ({ output: "assistant: done\n__SUBAGENT_DONE_0__" }),
      sidecarServices, maxAttempts: 3, pollIntervalMs: 0,
      sidecarGraceMs: 50,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    assert.equal(result.source, "sentinel");
    assert.equal(result.sidecarType, null);
    assert.equal(result.sidecarPath, null);
    assert.equal(result.status, "success");
    assert.equal(result.exitCode, 0);
    assert.ok(sleeps.includes(50), "grace sleep was issued");
  });

  it("AC4: timeout when neither sidecar nor sentinel within attempts", async () => {
    const waitForLaunchCompletion = await loadWaiter();
    const result = await waitForLaunchCompletion({
      launchId: "lid-4", stateDir: "/tmp/state",
      backend: "tmux", paneId: "pane:1", agentIdentifier: "claude",
      readPaneOutput: async () => ({ output: "still working..." }),
      sidecarServices: makeSidecarServices({}),
      maxAttempts: 2, pollIntervalMs: 0,
      sleep: async () => {},
    });
    assert.equal(result.source, "timeout");
    assert.equal(result.status, "timeout");
    assert.equal(result.exitCode, null);
    assert.equal(result.sidecarPath, null);
  });

  it("AC5: malformed sidecar JSON falls through to sentinel/timeout (no crash)", async () => {
    const waitForLaunchCompletion = await loadWaiter();
    const sidecarServices = makeSidecarServices({ "lid-5": "{not valid json" });
    const result = await waitForLaunchCompletion({
      launchId: "lid-5", stateDir: "/tmp/state",
      backend: "tmux", paneId: "pane:1", agentIdentifier: "claude",
      readPaneOutput: async () => ({ output: "__SUBAGENT_DONE_2__" }),
      sidecarServices, maxAttempts: 2, pollIntervalMs: 0,
      sleep: async () => {},
    });
    assert.equal(result.source, "sentinel");
    assert.equal(result.exitCode, 2);
    assert.equal(result.status, "failure");
  });

  it("AC6: sidecar appears between sentinel detection and grace expiry → source=sidecar", async () => {
    const waitForLaunchCompletion = await loadWaiter();
    let readCount = 0;
    let existsCount = 0;
    const sidecarServices = {
      existsSync: () => {
        existsCount += 1;
        return existsCount >= 3;
      },
      readFileSync: () => {
        readCount += 1;
        return JSON.stringify({ version: 1, type: "done", launchId: "lid-6", exitCode: 0, summary: "late write", writtenAt: "2025-01-01T00:00:00Z" });
      },
      warn: () => {},
    };
    const result = await waitForLaunchCompletion({
      launchId: "lid-6", stateDir: "/tmp/state",
      backend: "tmux", paneId: "pane:1", agentIdentifier: "claude",
      readPaneOutput: async () => ({ output: "__SUBAGENT_DONE_0__" }),
      sidecarServices, maxAttempts: 2, pollIntervalMs: 0,
      sidecarGraceMs: 10,
      sleep: async () => {},
    });
    assert.equal(result.source, "sidecar");
    assert.equal(result.summary, "late write");
  });

  it("AC7: emits structured log entries via injected log()", async () => {
    const waitForLaunchCompletion = await loadWaiter();
    const events = [];
    await waitForLaunchCompletion({
      launchId: "lid-7", stateDir: "/tmp/state",
      backend: "tmux", paneId: "pane:1", agentIdentifier: "claude",
      readPaneOutput: async () => ({ output: "" }),
      sidecarServices: makeSidecarServices({
        "lid-7": { version: 1, type: "done", launchId: "lid-7", exitCode: 0, summary: "x", writtenAt: "2025-01-01T00:00:00Z" },
      }),
      maxAttempts: 2, pollIntervalMs: 0,
      sleep: async () => {},
      log: (entry) => events.push(entry),
    });
    assert.deepEqual(events[0], { event: "summary.resolved", source: "sidecar", launchId: "lid-7" });
  });

  it("ADV: sidecar without launchId/stateDir is skipped silently (no read attempted)", async () => {
    const waitForLaunchCompletion = await loadWaiter();
    let readCalled = false;
    const result = await waitForLaunchCompletion({
      backend: "tmux", paneId: "pane:1", agentIdentifier: "claude",
      readPaneOutput: async () => ({ output: "__SUBAGENT_DONE_0__" }),
      sidecarServices: { existsSync: () => false, readFileSync: () => { readCalled = true; throw new Error("nope"); } },
      maxAttempts: 1, pollIntervalMs: 0,
      sleep: async () => {},
    });
    assert.equal(readCalled, false);
    assert.equal(result.source, "sentinel");
  });

  it("ADV: with sidecarGraceMs=0, no grace sleep is issued (even with stateDir set)", async () => {
    const waitForLaunchCompletion = await loadWaiter();
    const sleeps = [];
    await waitForLaunchCompletion({
      launchId: "lid-grace0", stateDir: "/tmp/state",
      backend: "tmux", paneId: "pane:1", agentIdentifier: "claude",
      readPaneOutput: async () => ({ output: "__SUBAGENT_DONE_0__" }),
      sidecarServices: makeSidecarServices({}),
      maxAttempts: 1, pollIntervalMs: 0,
      sidecarGraceMs: 0,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    assert.deepEqual(sleeps, [], "no sleep should be issued when sidecarGraceMs=0");
  });

  it("ADV: grace skipped when stateDir is missing even if launchId set", async () => {
    const waitForLaunchCompletion = await loadWaiter();
    const sleeps = [];
    await waitForLaunchCompletion({
      launchId: "lid-no-statedir",
      backend: "tmux", paneId: "pane:1", agentIdentifier: "claude",
      readPaneOutput: async () => ({ output: "__SUBAGENT_DONE_0__" }),
      sidecarServices: makeSidecarServices({}),
      maxAttempts: 1, pollIntervalMs: 0,
      sidecarGraceMs: 100,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    assert.equal(sleeps.includes(100), false, "grace must be gated by stateDir presence");
  });
});
