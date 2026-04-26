import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importProjectModule } from "../helpers/red-harness.mjs";

async function workspace(t) {
  const ws = await mkdtemp(path.join(os.tmpdir(), "copilot-pane-reap-"));
  t.after(async () => { await rm(ws, { recursive: true, force: true }); });
  return ws;
}

const baseAgent = { identifier: "github-copilot", agentKind: "builtin" };
const baseBackend = { selectedBackend: "tmux", action: "attach" };

describe("handleLaunchError pane reaping (Bug C: orphan panes on timeout/failure)", () => {
  it("GIVEN closePaneOnCompletion is true WHEN launchAgentInPane throws THEN closePane is called", async (t) => {
    const ws = await workspace(t);
    const { launchSingleSubagent } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/lib/launch.mjs",
      ["launchSingleSubagent"],
    );
    const { createStateStore } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/lib/state.mjs",
      ["createStateStore"],
    );

    const closeCalls = [];
    const result = await launchSingleSubagent({
      request: { workspacePath: ws, task: "x", closePaneOnCompletion: true },
      agentValidation: baseAgent,
      backendResolution: baseBackend,
      services: {
        stateStore: createStateStore({ workspacePath: ws }),
        openPane: async () => ({ paneId: "%9", visible: true }),
        launchAgentInPane: async () => { const e = new Error("simulated child failure"); e.timedOut = true; throw e; },
        closePane: ({ backend, paneId }) => closeCalls.push({ backend, paneId }),
      },
    });

    assert.equal(result.status, "timeout");
    assert.deepEqual(closeCalls, [{ backend: "tmux", paneId: "%9" }]);
  });

  it("GIVEN closePaneOnCompletion is false WHEN launchAgentInPane throws THEN closePane is NOT called", async (t) => {
    const ws = await workspace(t);
    const { launchSingleSubagent } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/lib/launch.mjs",
      ["launchSingleSubagent"],
    );
    const { createStateStore } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/lib/state.mjs",
      ["createStateStore"],
    );

    const closeCalls = [];
    await launchSingleSubagent({
      request: { workspacePath: ws, task: "x", closePaneOnCompletion: false },
      agentValidation: baseAgent,
      backendResolution: baseBackend,
      services: {
        stateStore: createStateStore({ workspacePath: ws }),
        openPane: async () => ({ paneId: "%9", visible: true }),
        launchAgentInPane: async () => { throw new Error("boom"); },
        closePane: (args) => closeCalls.push(args),
      },
    });

    assert.equal(closeCalls.length, 0);
  });
});
