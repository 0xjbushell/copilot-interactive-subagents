import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { importProjectModule } from "../helpers/red-harness.mjs";

async function workspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "d25-unit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("D2.5: resumeSubagent stale-ping cleanup", () => {
  it("deletes stale sidecar, marks respondedAt, resets lastExitType", async (t) => {
    const workspacePath = await workspace(t);
    const { resumeSubagent } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/lib/resume.mjs",
      ["resumeSubagent"],
    );
    const { createStateStore, createLaunchRecord, METADATA_VERSION } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/lib/state.mjs",
      ["createStateStore", "createLaunchRecord", "METADATA_VERSION"],
    );
    const { sidecarPath } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/lib/exit-sidecar.mjs",
      ["sidecarPath"],
    );

    const launchId = "ln-d25-unit";
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

    const fixedNow = "2025-04-04T04:04:04.000Z";
    let deleteCalls = 0;
    const result = await resumeSubagent({
      request: {
        launchId,
        task: "follow up",
        awaitCompletion: false,
        workspacePath,
        projectRoot: workspacePath,
        stateDir,
      },
      services: {
        now: () => fixedNow,
        acquireLock: () => ({ release: () => {} }),
        probeSessionLiveness: () => false,
        openPaneAndSendCommand: async () => ({ paneId: "%2", sessionId: "cs" }),
        deleteExitSidecar: ({ launchId: id }) => {
          deleteCalls += 1;
          assert.equal(id, launchId);
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(deleteCalls, 1);
    const finalRecord = await store.readLaunchRecord(launchId);
    assert.equal(finalRecord.lastExitType, null);
    assert.equal(finalRecord.pingHistory[0].respondedAt, fixedNow);
    assert.equal(finalRecord.pingHistory[0].sentAt, "2025-01-01T00:00:00.000Z");
  });

  it("does NOT touch sidecar/pingHistory when lastExitType is not ping", async (t) => {
    const workspacePath = await workspace(t);
    const { resumeSubagent } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/lib/resume.mjs",
      ["resumeSubagent"],
    );
    const { createStateStore, createLaunchRecord, METADATA_VERSION } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/lib/state.mjs",
      ["createStateStore", "createLaunchRecord", "METADATA_VERSION"],
    );

    const launchId = "ln-d25-noop";
    const stateDir = path.join(workspacePath, ".copilot-interactive-subagents");
    await mkdir(path.join(stateDir, "launches"), { recursive: true });

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
      status: "success",
      metadataVersion: METADATA_VERSION,
      pingHistory: [],
      lastExitType: "done",
    }));

    let deleteCalls = 0;
    await resumeSubagent({
      request: { launchId, awaitCompletion: false, workspacePath, projectRoot: workspacePath, stateDir },
      services: {
        acquireLock: () => ({ release: () => {} }),
        probeSessionLiveness: () => false,
        openPaneAndSendCommand: async () => ({ paneId: "%2", sessionId: "cs" }),
        deleteExitSidecar: () => { deleteCalls += 1; },
      },
    });

    assert.equal(deleteCalls, 0, "deleteExitSidecar must not run when lastExitType !== ping");
    const finalRecord = await store.readLaunchRecord(launchId);
    assert.equal(finalRecord.lastExitType, "done", "lastExitType preserved");
  });
});
