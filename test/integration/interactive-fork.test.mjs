import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { importProjectModule } from "../helpers/red-harness.mjs";

async function createWorkspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "e2e-interactive-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("interactive launch, fork, and subagent_done lifecycle", () => {
  it("GIVEN interactive launch WHEN pane opens THEN status is interactive and pane stays open", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );
    const { createStateStore } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createStateStore"],
    );

    let closePaneCalled = false;
    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({
        ok: true,
        selectedBackend: "tmux",
        action: "attach",
      }),
      createStateStore: () => createStateStore({ workspacePath }),
      openPane: async () => ({ paneId: "%5", visible: true }),
      launchAgentInPane: async () => ({ sessionId: "interactive-session" }),
      readPaneOutput: async () => ({ output: "" }),
      closePane: async () => { closePaneCalled = true; },
    });

    const result = await handlers.copilot_subagent_launch({
      workspacePath,
      requestedIdentifier: "interactive-agent",
      task: "Collaborate with user",
      interactive: true,
      enumerateCustomAgents: async () => [{ identifier: "interactive-agent" }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "interactive");

    const store = createStateStore({ workspacePath });
    const manifest = await store.readLaunchRecord(result.launchId);
    assert.equal(manifest.interactive, true);
    assert.equal(manifest.closePaneOnCompletion, false);
    assert.equal(manifest.status, "interactive");
    assert.ok(manifest.copilotSessionId, "Should have copilotSessionId");
    assert.equal(closePaneCalled, false, "Pane should NOT be closed for interactive");
  });

  it("GIVEN parallel launch of mixed agents WHEN both planned THEN each gets correct mode", async () => {
    const { planParallelLaunches } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/parallel.mjs",
      ["planParallelLaunches"],
    );

    const launches = [
      {
        request: { requestedIdentifier: "auto-agent", task: "auto task" },
        agentValidation: { ok: true, identifier: "auto-agent", agentKind: "built-in" },
      },
      {
        request: { requestedIdentifier: "interactive-agent", task: "interactive task", interactive: true },
        agentValidation: { ok: true, identifier: "interactive-agent", agentKind: "custom" },
      },
    ];

    let counter = 0;
    const planned = planParallelLaunches({
      launches,
      backendResolution: { ok: true, selectedBackend: "tmux", action: "attach" },
      createLaunchId: () => "e2e-parallel-" + counter++,
      now: () => "2025-01-01T00:00:00.000Z",
    });

    assert.equal(planned.length, 2);
    assert.equal(planned[0].plan.interactive, false);
    assert.equal(planned[0].plan.closePaneOnCompletion, true);
    assert.equal(planned[1].plan.interactive, true);
    assert.equal(planned[1].plan.closePaneOnCompletion, false);
    assert.notEqual(planned[0].plan.copilotSessionId, planned[1].plan.copilotSessionId);
  });
});
