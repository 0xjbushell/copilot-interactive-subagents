import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

import { importProjectModule } from "../helpers/red-harness.mjs";

async function createWorkspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ping-resume-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function exists(p) {
  try { await access(p, fsConstants.F_OK); return true; } catch { return false; }
}

describe("D2.5: ping → resume(task) → done full cycle", () => {
  it("clears stale ping sidecar, marks respondedAt, resets lastExitType, and completes resume on fresh done sidecar", async (t) => {
    const workspacePath = await createWorkspace(t);

    const { resumeSubagent } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
      ["resumeSubagent"],
    );
    const { createStateStore, createLaunchRecord, METADATA_VERSION } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createStateStore", "createLaunchRecord", "METADATA_VERSION"],
    );
    const { writeExitSidecar, sidecarPath } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/exit-sidecar.mjs",
      ["writeExitSidecar", "sidecarPath"],
    );

    const launchId = "ln-d25-cycle";
    const stateDir = path.join(workspacePath, ".copilot-interactive-subagents");
    await mkdir(path.join(stateDir, "launches"), { recursive: true });

    const initialPingSentAt = "2025-01-01T00:00:00.000Z";
    const initialRecord = createLaunchRecord({
      launchId,
      agentIdentifier: "github-copilot",
      agentKind: "built-in",
      backend: "tmux",
      paneId: "%9",
      sessionId: "child-sess-uuid",
      copilotSessionId: "copilot-sess-uuid",
      requestedAt: "2025-01-01T00:00:00.000Z",
      status: "ping",
      summary: null,
      exitCode: 0,
      metadataVersion: METADATA_VERSION,
      pingHistory: [{ message: "What about Y?", sentAt: initialPingSentAt }],
      lastExitType: "ping",
      sidecarPath: sidecarPath(stateDir, launchId),
    });
    const store = createStateStore({ workspacePath });
    await store.writeLaunchRecord(initialRecord);

    // Stale ping sidecar lives on disk from prior cycle.
    await mkdir(path.join(stateDir, "exit"), { recursive: true });
    await writeFile(
      sidecarPath(stateDir, launchId),
      JSON.stringify({ version: 1, type: "ping", launchId, message: "What about Y?", writtenAt: initialPingSentAt }),
    );
    assert.equal(await exists(sidecarPath(stateDir, launchId)), true, "stale sidecar must exist before resume");

    // Pre-write the FRESH done sidecar so waitForLaunchCompletion observes it
    // immediately on the first poll tick (eliminates real-timer race).
    // We do this AFTER the resume's stale-cleanup deletes the prior sidecar
    // by deferring the write into the openPaneAndSendCommand stub.

    let openCalls = 0;
    const fixedNow = "2025-02-01T00:00:00.000Z";
    const services = {
      now: () => fixedNow,
      acquireLock: () => ({ release: () => {} }),
      probeSessionLiveness: () => false,
      openPaneAndSendCommand: async ({ task }) => {
        openCalls += 1;
        assert.equal(task, "Use Z instead", "task field must be threaded to child");
        // Simulate child writing the new "done" sidecar in response to resume.
        writeExitSidecar({
          launchId,
          type: "done",
          summary: "Resolved with Z",
          exitCode: 0,
          stateDir,
        });
        return { paneId: "%10", sessionId: "child-sess-uuid" };
      },
      readPaneOutput: () => ({ output: "" }),
      readChildSessionState: () => null,
      closePane: () => {},
    };

    const result = await resumeSubagent({
      request: {
        launchId,
        task: "Use Z instead",
        awaitCompletion: true,
        workspacePath,
        projectRoot: workspacePath,
        stateDir,
        sidecarGraceMs: 0,
        pollIntervalMs: 1,
        maxMonitorAttempts: 5,
        sleep: async () => {},
      },
      services,
    });

    assert.equal(openCalls, 1, "openPaneAndSendCommand called exactly once");
    assert.equal(result.ok, true, "resume succeeded");
    assert.equal(result.status, "success", "fresh done sidecar maps to success");
    assert.equal(result.summary, "Resolved with Z");

    const finalRecord = await store.readLaunchRecord(launchId);
    assert.equal(finalRecord.lastExitType, "done", "fresh terminal state recorded");
    assert.equal(finalRecord.pingHistory.length, 1, "no new ping appended");
    assert.equal(finalRecord.pingHistory[0].respondedAt, fixedNow, "prior ping has respondedAt populated");
    assert.equal(finalRecord.pingHistory[0].sentAt, initialPingSentAt, "prior ping sentAt preserved");
    assert.equal(finalRecord.status, "success");
  });

  it("resumeSubagent with awaitCompletion=false still clears stale sidecar and marks respondedAt", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { resumeSubagent } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
      ["resumeSubagent"],
    );
    const { createStateStore, createLaunchRecord, METADATA_VERSION } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createStateStore", "createLaunchRecord", "METADATA_VERSION"],
    );
    const { sidecarPath } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/exit-sidecar.mjs",
      ["sidecarPath"],
    );

    const launchId = "ln-d25-fafo";
    const stateDir = path.join(workspacePath, ".copilot-interactive-subagents");
    await mkdir(path.join(stateDir, "launches"), { recursive: true });
    await mkdir(path.join(stateDir, "exit"), { recursive: true });

    await writeFile(
      sidecarPath(stateDir, launchId),
      JSON.stringify({ version: 1, type: "ping", launchId, message: "?", writtenAt: "2025-01-01T00:00:00.000Z" }),
    );

    const store = createStateStore({ workspacePath });
    await store.writeLaunchRecord(createLaunchRecord({
      launchId,
      agentIdentifier: "github-copilot",
      agentKind: "built-in",
      backend: "tmux",
      paneId: "%1",
      sessionId: "s",
      copilotSessionId: "cs",
      requestedAt: "2025-01-01T00:00:00.000Z",
      status: "ping",
      metadataVersion: METADATA_VERSION,
      pingHistory: [{ message: "?", sentAt: "2025-01-01T00:00:00.000Z" }],
      lastExitType: "ping",
    }));

    const fixedNow = "2025-03-03T03:03:03.000Z";
    let deleteCalls = 0;
    const services = {
      now: () => fixedNow,
      acquireLock: () => ({ release: () => {} }),
      probeSessionLiveness: () => false,
      openPaneAndSendCommand: async () => ({ paneId: "%2", sessionId: "cs" }),
      deleteExitSidecar: ({ launchId: id }) => {
        deleteCalls += 1;
        assert.equal(id, launchId);
      },
    };

    const result = await resumeSubagent({
      request: {
        launchId,
        task: "follow up",
        awaitCompletion: false,
        workspacePath,
        projectRoot: workspacePath,
        stateDir,
      },
      services,
    });

    assert.equal(result.ok, true);
    assert.equal(deleteCalls, 1, "stale sidecar removal invoked");
    const finalRecord = await store.readLaunchRecord(launchId);
    assert.equal(finalRecord.lastExitType, null, "lastExitType reset to null on relaunch");
    assert.equal(finalRecord.pingHistory[0].respondedAt, fixedNow);
  });
});
