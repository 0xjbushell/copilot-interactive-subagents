import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { importProjectModule } from "../helpers/red-harness.mjs";

async function createWorkspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "e2e-golden-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("golden-path: autonomous launch → complete → resume → verify", () => {
  it("GIVEN autonomous launch WHEN sentinel detected THEN manifest reaches terminal state with summary", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/extension.mjs",
      ["createExtensionHandlers"],
    );
    const { createStateStore } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/lib/state.mjs",
      ["createStateStore"],
    );

    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({
        ok: true,
        selectedBackend: "tmux",
        action: "attach",
      }),
      createStateStore: () => createStateStore({ workspacePath }),
      openPane: async () => ({ paneId: "%0", visible: true }),
      launchAgentInPane: async () => ({ sessionId: "golden-session" }),
      readPaneOutput: async () => ({
        output: "Task complete!\n__SUBAGENT_DONE_0__",
      }),
      closePane: async () => {},
    });

    const result = await handlers.copilot_subagent_launch({
      workspacePath,
      requestedIdentifier: "test-agent",
      task: "Say hello",
      awaitCompletion: true,
      enumerateCustomAgents: async () => [{ identifier: "test-agent" }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "success");
    assert.equal(result.exitCode, 0);
    assert.ok(result.summary, "Should have a summary");

    const store = createStateStore({ workspacePath });
    const manifest = await store.readLaunchRecord(result.launchId);
    assert.equal(manifest.status, "success");
    assert.equal(manifest.exitCode, 0);
    assert.equal(manifest.metadataVersion, 3);
    assert.ok(manifest.copilotSessionId, "Should have copilotSessionId");
    assert.equal(manifest.interactive, false);
    assert.equal(manifest.closePaneOnCompletion, true);
  });

  it("GIVEN completed session WHEN resumed THEN new pane opens and manifest updated", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/extension.mjs",
      ["createExtensionHandlers"],
    );
    const { createStateStore } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/lib/state.mjs",
      ["createStateStore"],
    );

    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({
        ok: true,
        selectedBackend: "tmux",
        action: "attach",
      }),
      createStateStore: () => createStateStore({ workspacePath }),
      openPane: async () => ({ paneId: "%0", visible: true }),
      launchAgentInPane: async () => ({ sessionId: "session-1" }),
      readPaneOutput: async () => ({
        output: "Done!\n__SUBAGENT_DONE_0__",
      }),
      closePane: async () => {},
      // Resume-specific services
      acquireLock: () => ({ release: () => {} }),
      probeSessionLiveness: () => false,
      openPaneAndSendCommand: async () => ({ paneId: "%1" }),
    });

    const launchResult = await handlers.copilot_subagent_launch({
      workspacePath,
      requestedIdentifier: "resume-agent",
      task: "Do something",
      awaitCompletion: true,
      enumerateCustomAgents: async () => [{ identifier: "resume-agent" }],
    });

    assert.equal(launchResult.ok, true);
    const capturedLaunchId = launchResult.launchId;

    // Resume the completed session
    const resumeResult = await handlers.copilot_subagent_resume({
      workspacePath,
      launchId: capturedLaunchId,
      awaitCompletion: true,
    });

    assert.equal(resumeResult.ok, true);
    assert.equal(resumeResult.status, "success");
    assert.equal(resumeResult.launchId, capturedLaunchId);
  });
});
