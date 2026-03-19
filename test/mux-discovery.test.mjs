import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { importProjectModule } from "./helpers/red-harness.mjs";

describe("mux discovery and launch prerequisites", () => {
  it("GIVEN runtime multiplexers are available WHEN discovery runs THEN it returns launchable supported backends", async () => {
    const { discoverLaunchBackends } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/mux.mjs",
      ["discoverLaunchBackends"],
    );

    const result = await discoverLaunchBackends({
      env: {
        CMUX_SOCKET_PATH: "/tmp/cmux.sock",
        TMUX: "/tmp/tmux-1000/default,123,0",
        ZELLIJ_SESSION_NAME: "workspace",
      },
      hasCommand: (command) => ["cmux", "tmux", "zellij"].includes(command),
      startupSupport: {
        cmux: true,
        tmux: true,
        zellij: true,
      },
    });

    assert.deepEqual(result, [
      {
        backend: "cmux",
        source: "attached",
        attachable: true,
        startSupported: true,
      },
      {
        backend: "tmux",
        source: "attached",
        attachable: true,
        startSupported: true,
      },
      {
        backend: "zellij",
        source: "attached",
        attachable: true,
        startSupported: true,
      },
    ]);
  });

  it("GIVEN multiple active multiplexers WHEN backend selection runs THEN it chooses the same supported backend deterministically before launching", async () => {
    const { resolveLaunchBackend } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/mux.mjs",
      ["resolveLaunchBackend"],
    );

    const input = {
      env: {
        CMUX_SOCKET_PATH: "/tmp/cmux.sock",
        TMUX: "/tmp/tmux-1000/default,123,0",
        ZELLIJ: "1",
      },
      hasCommand: () => true,
      startupSupport: {
        cmux: true,
        tmux: true,
        zellij: true,
      },
      attach: async (backend) => ({
        backend,
        attached: true,
      }),
      start: async () => {
        assert.fail("resolveLaunchBackend should attach before attempting auto-start.");
      },
      stateStore: {
        async writeLaunchRecord() {
          assert.fail("launch metadata should not be written during prerequisite selection.");
        },
      },
    };

    const firstResult = await resolveLaunchBackend(input);
    const secondResult = await resolveLaunchBackend(input);

    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
    assert.equal(firstResult.action, "attach");
    assert.equal(secondResult.action, "attach");
    assert.ok(["cmux", "tmux", "zellij"].includes(firstResult.selectedBackend));
    assert.equal(firstResult.selectedBackend, secondResult.selectedBackend);
  });

  it("GIVEN the user is outside a multiplexer WHEN an auto-startable backend is present THEN selection continues without manual pane setup", async () => {
    const { resolveLaunchBackend } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/mux.mjs",
      ["resolveLaunchBackend"],
    );

    const starts = [];
    const result = await resolveLaunchBackend({
      env: {},
      hasCommand: (command) => command === "tmux",
      startupSupport: {
        cmux: false,
        tmux: true,
        zellij: false,
      },
      attach: async () => {
        assert.fail("resolveLaunchBackend should not try to attach when no supported runtime is active.");
      },
      start: async (backend) => {
        starts.push(backend);
        return {
          backend,
          sessionName: "copilot-interactive-subagents",
        };
      },
      stateStore: {
        async writeLaunchRecord() {
          assert.fail("launch metadata should not be persisted until pane creation actually begins.");
        },
      },
    });

    assert.deepEqual(starts, ["tmux"]);
    assert.equal(result.ok, true);
    assert.equal(result.selectedBackend, "tmux");
    assert.equal(result.action, "start");
    assert.equal(result.manualSetupRequired, false);
  });

  it("GIVEN no supported backend can be attached or started WHEN launch prerequisites are checked THEN setup guidance is returned and no orphaned metadata remains", async () => {
    const { resolveLaunchBackend } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/mux.mjs",
      ["resolveLaunchBackend"],
    );

    const writes = [];
    const result = await resolveLaunchBackend({
      env: {},
      hasCommand: () => false,
      startupSupport: {
        cmux: false,
        tmux: false,
        zellij: false,
      },
      attach: async () => {
        assert.fail("resolveLaunchBackend should not try to attach when no backend is detectable.");
      },
      start: async () => {
        assert.fail("resolveLaunchBackend should not try to auto-start an unavailable backend.");
      },
      stateStore: {
        async writeLaunchRecord(record) {
          writes.push(record);
        },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "BACKEND_UNAVAILABLE");
    assert.match(result.setupGuidance, /cmux|tmux|zellij/);
    assert.deepEqual(result.availableBackends, []);
    assert.deepEqual(writes, []);
  });

  it("GIVEN an active backend attach path fails WHEN launch prerequisites are checked THEN setup guidance is returned and no stale launch metadata is written", async () => {
    const { resolveLaunchBackend } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/mux.mjs",
      ["resolveLaunchBackend"],
    );

    const writes = [];
    const result = await resolveLaunchBackend({
      env: {
        TMUX: "/tmp/tmux-1000/default,123,0",
      },
      hasCommand: (command) => command === "tmux",
      startupSupport: {
        cmux: false,
        tmux: true,
        zellij: false,
      },
      attach: async () => {
        throw new Error("tmux attach probe failed");
      },
      start: async () => {
        assert.fail("resolveLaunchBackend should not fall through to auto-start after attach fails.");
      },
      stateStore: {
        async writeLaunchRecord(record) {
          writes.push(record);
        },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "BACKEND_UNAVAILABLE");
    assert.equal(result.requestedBackend, undefined);
    assert.equal(result.detectedBackend, "tmux");
    assert.match(result.setupGuidance, /tmux/i);
    assert.match(result.message, /attach probe failed/i);
    assert.deepEqual(writes, []);
  });

  it("GIVEN an explicit backend request WHEN that backend cannot be auto-started THEN a backend-specific failure code is returned", async () => {
    const { resolveLaunchBackend } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/mux.mjs",
      ["resolveLaunchBackend"],
    );

    const result = await resolveLaunchBackend({
      requestedBackend: "tmux",
      env: {},
      hasCommand: (command) => command === "tmux",
      startupSupport: {
        cmux: false,
        tmux: false,
        zellij: false,
      },
      attach: async () => {
        assert.fail("resolveLaunchBackend should not attach when the requested backend is not active.");
      },
      start: async () => {
        assert.fail("resolveLaunchBackend should not start a backend whose startup path is unsupported.");
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "BACKEND_START_UNSUPPORTED");
    assert.equal(result.requestedBackend, "tmux");
    assert.match(result.setupGuidance, /tmux/i);
  });

  it("GIVEN an explicit attached backend request WHEN attach fails THEN launch prerequisite resolution fails instead of starting a nested session", async () => {
    const { resolveLaunchBackend } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/mux.mjs",
      ["resolveLaunchBackend"],
    );

    const result = await resolveLaunchBackend({
      requestedBackend: "tmux",
      env: {
        TMUX: "/tmp/tmux-1000/default,123,0",
      },
      hasCommand: (command) => command === "tmux",
      startupSupport: {
        cmux: false,
        tmux: true,
        zellij: false,
      },
      attach: async () => {
        throw new Error("tmux attach probe failed");
      },
      start: async () => {
        assert.fail("resolveLaunchBackend should not start a nested tmux session after attach fails.");
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "BACKEND_UNAVAILABLE");
    assert.equal(result.requestedBackend, "tmux");
    assert.equal(result.detectedBackend, "tmux");
    assert.match(result.message, /attach probe failed/i);
  });

  it("GIVEN the extension entrypoint is wired with discovery services WHEN list-agents runs THEN it reports exact agent identifiers alongside launchable backends", async () => {
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );

    const handlers = await createExtensionHandlers({
      listRuntimeAgents: async () => ({
        runtimeRecognizedIdentifiers: ["reviewer", "worker"],
        builtInIdentifiersAcceptedExplicitly: ["github-copilot"],
        exactNameOnly: true,
      }),
      discoverLaunchBackends: async () => [
        {
          backend: "tmux",
          source: "attached",
          attachable: true,
          startSupported: true,
        },
        {
          backend: "zellij",
          source: "startable",
          attachable: false,
          startSupported: true,
        },
      ],
    });

    const result = await handlers.copilotSubagentListAgents({});

    assert.deepEqual(result, {
      agentIdentifiers: ["reviewer", "worker"],
      builtInIdentifiersAcceptedExplicitly: ["github-copilot"],
      exactNameOnly: true,
      supportedBackends: [
        {
          backend: "tmux",
          source: "attached",
          attachable: true,
          startSupported: true,
        },
        {
          backend: "zellij",
          source: "startable",
          attachable: false,
          startSupported: true,
        },
      ],
    });
  });

  it("GIVEN runtime discovery uses PATH probing WHEN tmux is only available via PATH THEN it still reports tmux as launchable", async () => {
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );

    const tempPath = await mkdtemp(path.join(os.tmpdir(), "copilot-subagent-path-"));

    try {
      const tmuxPath = path.join(tempPath, "tmux");
      await writeFile(tmuxPath, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(tmuxPath, 0o755);

      const handlers = await createExtensionHandlers({
        env: { PATH: tempPath },
        listRuntimeAgents: async () => ({
          runtimeRecognizedIdentifiers: ["reviewer"],
          builtInIdentifiersAcceptedExplicitly: ["github-copilot"],
          exactNameOnly: true,
        }),
      });

      const result = await handlers.copilotSubagentListAgents({});

      assert.deepEqual(result.supportedBackends, [
        {
          backend: "tmux",
          source: "startable",
          attachable: false,
          startSupported: true,
        },
      ]);
    } finally {
      await rm(tempPath, { recursive: true, force: true });
    }
  });
});
