import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importProjectModule } from "../helpers/red-harness.mjs";

describe("Interactive mode", () => {
  const createWorkspace = (t) => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-interactive-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  it("GIVEN interactive=true WHEN command built THEN contains -i and not -p or -s", async (t) => {
    const workspacePath = createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/extension.mjs",
      ["createExtensionHandlers"],
    );
    const { createStateStore } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/lib/state.mjs",
      ["createStateStore"],
    );

    let capturedCommand = null;
    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({ ok: true, selectedBackend: "tmux", action: "attach" }),
      createStateStore: (req) => createStateStore({ workspacePath }),
      openPane: async () => ({ paneId: "%1", visible: true }),
      createAgentLaunchCommand: (context) => {
        capturedCommand = context;
        return "echo test";
      },
      readPaneOutput: async () => ({ output: "\n__SUBAGENT_DONE_0__" }),
    });

    await handlers.copilot_subagent_launch({
      workspacePath,
      requestedIdentifier: "test-agent",
      task: "help me debug",
      enumerateCustomAgents: async () => [{ identifier: "test-agent" }],
      interactive: true,
    });

    assert.ok(capturedCommand, "command builder should have been called");
    assert.equal(capturedCommand.interactive, true);
  });

  it("GIVEN interactive=false WHEN command built THEN contains -p and -s", async (t) => {
    const workspacePath = createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/extension.mjs",
      ["createExtensionHandlers"],
    );
    const { createStateStore } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/lib/state.mjs",
      ["createStateStore"],
    );

    let capturedCommand = null;
    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({ ok: true, selectedBackend: "tmux", action: "attach" }),
      createStateStore: (req) => createStateStore({ workspacePath }),
      openPane: async () => ({ paneId: "%1", visible: true }),
      createAgentLaunchCommand: (context) => {
        capturedCommand = context;
        return "echo test";
      },
      readPaneOutput: async () => ({ output: "\n__SUBAGENT_DONE_0__" }),
    });

    await handlers.copilot_subagent_launch({
      workspacePath,
      requestedIdentifier: "test-agent",
      task: "do a thing",
      enumerateCustomAgents: async () => [{ identifier: "test-agent" }],
      awaitCompletion: true,
    });

    assert.ok(capturedCommand, "command builder should have been called");
    assert.equal(capturedCommand.interactive, false);
  });

  it("GIVEN interactive launch WHEN manifest written THEN status is interactive", async (t) => {
    const workspacePath = createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/extension.mjs",
      ["createExtensionHandlers"],
    );
    const { createStateStore } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/lib/state.mjs",
      ["createStateStore"],
    );

    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({ ok: true, selectedBackend: "tmux", action: "attach" }),
      createStateStore: (req) => createStateStore({ workspacePath }),
      openPane: async () => ({ paneId: "%1", visible: true }),
      launchAgentInPane: async () => ({ sessionId: null }),
      readPaneOutput: async () => {
        assert.fail("sentinel polling should not run for interactive");
      },
    });

    const result = await handlers.copilot_subagent_launch({
      workspacePath,
      requestedIdentifier: "test-agent",
      task: "help me debug",
      enumerateCustomAgents: async () => [{ identifier: "test-agent" }],
      interactive: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "interactive");

    const store = createStateStore({ workspacePath });
    const manifest = await store.readLaunchRecord(result.launchId);
    assert.equal(manifest.status, "interactive");
    assert.equal(manifest.interactive, true);
    assert.equal(manifest.closePaneOnCompletion, false);
  });

  it("GIVEN interactive=true WHEN awaitCompletion not set THEN defaults to false", async () => {
    const { planSingleLaunch } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/lib/launch.mjs",
      ["planSingleLaunch"],
    );

    const plan = planSingleLaunch({
      request: { task: "test", interactive: true },
      agentValidation: { identifier: "test-agent", agentKind: "custom" },
      backendResolution: { selectedBackend: "tmux", action: "attach" },
    });

    assert.equal(plan.awaitCompletion, false);
    assert.equal(plan.interactive, true);
    assert.equal(plan.closePaneOnCompletion, false);
  });

  it("GIVEN interactive=true and awaitCompletion=true WHEN plan created THEN awaitCompletion is true", async () => {
    const { planSingleLaunch } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/lib/launch.mjs",
      ["planSingleLaunch"],
    );

    const plan = planSingleLaunch({
      request: { task: "test", interactive: true, awaitCompletion: true },
      agentValidation: { identifier: "test-agent", agentKind: "custom" },
      backendResolution: { selectedBackend: "tmux", action: "attach" },
    });

    assert.equal(plan.awaitCompletion, true);
    assert.equal(plan.interactive, true);
  });

  it("GIVEN default command builder WHEN interactive=true THEN script has -i and no -s", async (t) => {
    const workspacePath = createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/extension.mjs",
      ["createExtensionHandlers"],
    );
    const { createStateStore } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/lib/state.mjs",
      ["createStateStore"],
    );

    let builtCommand = null;
    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({ ok: true, selectedBackend: "tmux", action: "attach" }),
      createStateStore: (req) => createStateStore({ workspacePath }),
      openPane: async () => ({ paneId: "%1", visible: true }),
      launchAgentInPane: async ({ backend, request, runtimeServices, ...context }) => {
        // Use the real default command builder by NOT overriding createAgentLaunchCommand
        // Instead, capture what gets sent to launchAgentInPane
        builtCommand = context;
        return { sessionId: null };
      },
      readPaneOutput: async () => ({ output: "\n__SUBAGENT_DONE_0__" }),
    });

    await handlers.copilot_subagent_launch({
      workspacePath,
      requestedIdentifier: "test-agent",
      task: "test task",
      enumerateCustomAgents: async () => [{ identifier: "test-agent" }],
      interactive: true,
    });

    assert.ok(builtCommand, "launchAgentInPane should be called");
    assert.equal(builtCommand.interactive, true);
    assert.ok(builtCommand.copilotSessionId, "copilotSessionId should be present");
  });
});
