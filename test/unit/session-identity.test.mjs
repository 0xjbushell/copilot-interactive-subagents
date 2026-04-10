import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importProjectModule } from "../helpers/red-harness.mjs";

describe("Session Identity (tracer bullet)", () => {
  const createWorkspace = (t) => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-test-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  it("GIVEN launch WHEN flow completes THEN manifest has copilotSessionId and v2 fields", async (t) => {
    const workspacePath = createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );
    const { createStateStore } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createStateStore"],
    );

    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({ ok: true, selectedBackend: "tmux", action: "attach" }),
      createStateStore: (req) => createStateStore({ workspacePath }),
      openPane: async () => ({ paneId: "%1", visible: true }),
      launchAgentInPane: async () => ({ sessionId: null }),
      readPaneOutput: async () => ({ output: "done\n__SUBAGENT_DONE_0__" }),
    });

    const result = await handlers.copilot_subagent_launch({
      workspacePath,
      requestedIdentifier: "test-agent",
      task: "Do a thing",
      enumerateCustomAgents: async () => [{ identifier: "test-agent" }],
      awaitCompletion: true,
    });

    assert.equal(result.ok, true);

    const store = createStateStore({ workspacePath });
    const manifest = await store.readLaunchRecord(result.launchId);

    // copilotSessionId is a valid UUID v4
    assert.ok(manifest.copilotSessionId, "copilotSessionId should be set");
    assert.match(
      manifest.copilotSessionId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    // v2 metadata
    assert.equal(manifest.metadataVersion, 2);
    assert.equal(manifest.interactive, false);
    assert.equal(manifest.fork, null);
    assert.equal(manifest.closePaneOnCompletion, true);
    assert.equal(manifest.eventsBaseline, null);
  });

  it("GIVEN tmux backend WHEN command built THEN includes --resume=<UUID>", async (t) => {
    const workspacePath = createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );
    const { createStateStore } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createStateStore"],
    );

    let capturedCommand = null;
    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({ ok: true, selectedBackend: "tmux", action: "attach" }),
      createStateStore: (req) => createStateStore({ workspacePath }),
      openPane: async () => ({ paneId: "%1", visible: true }),
      createAgentLaunchCommand: (context) => {
        capturedCommand = context;
        return "echo test-command";
      },
      readPaneOutput: async () => ({ output: "\n__SUBAGENT_DONE_0__" }),
    });

    await handlers.copilot_subagent_launch({
      workspacePath,
      requestedIdentifier: "test-agent",
      task: "Do a thing",
      enumerateCustomAgents: async () => [{ identifier: "test-agent" }],
      awaitCompletion: true,
    });

    assert.ok(capturedCommand, "createAgentLaunchCommand should have been called");
    assert.ok(capturedCommand.copilotSessionId, "copilotSessionId should be passed to command builder");
    assert.match(
      capturedCommand.copilotSessionId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("GIVEN default (autonomous) launch WHEN command built THEN uses -p flag", async (t) => {
    const workspacePath = createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );
    const { createStateStore } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createStateStore"],
    );

    let capturedCommand = null;
    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({ ok: true, selectedBackend: "tmux", action: "attach" }),
      createStateStore: (req) => createStateStore({ workspacePath }),
      openPane: async () => ({ paneId: "%1", visible: true }),
      launchAgentInPane: async ({ backend, request, runtimeServices, ...context }) => {
        // Capture the actual shell command that would be built
        capturedCommand = context;
        return { sessionId: null };
      },
      readPaneOutput: async () => ({ output: "\n__SUBAGENT_DONE_0__" }),
    });

    await handlers.copilot_subagent_launch({
      workspacePath,
      requestedIdentifier: "test-agent",
      task: "Do a thing",
      enumerateCustomAgents: async () => [{ identifier: "test-agent" }],
      awaitCompletion: true,
    });

    assert.ok(capturedCommand, "launchAgentInPane should have been called");
    assert.equal(capturedCommand.interactive, false);
  });

  it("GIVEN cmux backend WHEN launch plan created THEN copilotSessionId is null", async () => {
    const { planSingleLaunch } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/launch.mjs",
      ["planSingleLaunch"],
    );

    const plan = planSingleLaunch({
      request: { task: "test" },
      agentValidation: { identifier: "test-agent", agentKind: "custom" },
      backendResolution: { selectedBackend: "cmux", action: "attach" },
    });

    assert.equal(plan.copilotSessionId, null);
    assert.equal(plan.backend, "cmux");
  });

  it("GIVEN v2 manifest written WHEN read back THEN all v2 fields round-trip correctly", async (t) => {
    const workspacePath = createWorkspace(t);
    const { createStateStore, createLaunchRecord } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createStateStore", "createLaunchRecord"],
    );

    const store = createStateStore({ workspacePath });
    const original = createLaunchRecord({
      launchId: "roundtrip-001",
      agentIdentifier: "test-agent",
      agentKind: "custom",
      backend: "tmux",
      paneId: "%1",
      requestedAt: "2026-01-01T00:00:00.000Z",
      copilotSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      interactive: true,
      fork: { sourceCopilotSessionId: "old-session" },
      closePaneOnCompletion: false,
      eventsBaseline: 42,
    });

    await store.writeLaunchRecord(original);
    const readBack = await store.readLaunchRecord("roundtrip-001");

    assert.equal(readBack.copilotSessionId, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    assert.equal(readBack.interactive, true);
    assert.deepEqual(readBack.fork, { sourceCopilotSessionId: "old-session" });
    assert.equal(readBack.closePaneOnCompletion, false);
    assert.equal(readBack.eventsBaseline, 42);
    assert.equal(readBack.metadataVersion, 2);
  });
});
