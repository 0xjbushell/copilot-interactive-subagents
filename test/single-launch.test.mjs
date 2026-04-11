import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { importProjectModule } from "./helpers/red-harness.mjs";

async function createWorkspace(t) {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "copilot-interactive-subagents-"));
  t.after(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  return workspacePath;
}

describe("single pane-backed launch orchestration", () => {
  it("normalizes a single-launch plan before orchestration begins", async () => {
    const { planSingleLaunch } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/launch.mjs",
      ["planSingleLaunch"],
    );

    const plan = planSingleLaunch({
      request: {
        requestedIdentifier: "reviewer",
        task: "Audit failing tests",
        awaitCompletion: true,
      },
      agentValidation: {
        identifier: "reviewer",
        agentKind: "custom",
      },
      backendResolution: {
        selectedBackend: "tmux",
        action: "attach",
      },
      createLaunchId: () => "launch-001",
      now: () => "2026-03-19T00:00:00.000Z",
    });

    assert.deepEqual(plan, {
      launchId: "launch-001",
      agentIdentifier: "reviewer",
      agentKind: "custom",
      backend: "tmux",
      launchAction: "attach",
      backendSessionName: null,
      task: "Audit failing tests",
      awaitCompletion: true,
      requestedAt: "2026-03-19T00:00:00.000Z",
      sessionId: null,
      summary: null,
      exitCode: null,
      metadataVersion: 2,
      copilotSessionId: plan.copilotSessionId,
      interactive: false,
      fork: null,
      closePaneOnCompletion: true,
      eventsBaseline: null,
    });
  });

  it("prefers an explicit child summary over assistant output or fallback text", async () => {
    const { extractLaunchSummary } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/summary.mjs",
      ["extractLaunchSummary"],
    );

    const summary = extractLaunchSummary({
      persistedExplicitSummary: "Final answer from child state",
      paneOutput: "assistant: Intermediate output\n__SUBAGENT_DONE_0__",
      agentIdentifier: "reviewer",
      backend: "tmux",
      paneId: "%1",
      sessionId: "session-123",
      status: "success",
      exitCode: 0,
    });

    assert.deepEqual(summary, {
      source: "explicit-summary",
      summary: "Final answer from child state",
    });
  });

  it("derives a deterministic non-empty fallback summary when no clear summary block exists", async () => {
    const { extractLaunchSummary, mapExitState } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/summary.mjs",
      ["extractLaunchSummary", "mapExitState"],
    );

    const status = mapExitState({ exitCode: 9 });
    const summary = extractLaunchSummary({
      paneOutput: "noise only\n__SUBAGENT_DONE_9__",
      agentIdentifier: "reviewer",
      backend: "tmux",
      paneId: "%2",
      sessionId: null,
      status,
      exitCode: 9,
    });

    assert.equal(status, "failure");
    assert.equal(summary.source, "fallback");
    assert.match(summary.summary, /reviewer/i);
    assert.match(summary.summary, /tmux/i);
    assert.match(summary.summary, /%2/);
    assert.match(summary.summary, /9/);
  });

  it("maps exit-state flags into stable terminal statuses", async () => {
    const { mapExitState } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/summary.mjs",
      ["mapExitState"],
    );

    assert.equal(mapExitState({ exitCode: 0 }), "success");
    assert.equal(mapExitState({ exitCode: 3 }), "failure");
    assert.equal(mapExitState({ exitCode: 130, cancelled: true }), "cancelled");
    assert.equal(mapExitState({ exitCode: null, timedOut: true }), "timeout");
  });

  it("GIVEN a valid backend and exact agent identifier WHEN the single-launch entrypoint runs THEN it opens a visible pane, starts the child agent, and returns pane/session metadata plus the final summary", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );
    const { createStateStore } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createStateStore"],
    );

    let openPaneCalls = 0;
    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({
        ok: true,
        selectedBackend: "tmux",
        action: "attach",
        manualSetupRequired: false,
      }),
      createStateStore: (request) => createStateStore({ workspacePath: request.workspacePath }),
      openPane: async ({ backend, launchAction, visible }) => {
        openPaneCalls += 1;
        assert.equal(backend, "tmux");
        assert.equal(launchAction, "attach");
        assert.equal(visible, true);
        return {
          paneId: "%1",
          visible: true,
        };
      },
      launchAgentInPane: async ({ paneId, agentIdentifier, task }) => {
        assert.equal(paneId, "%1");
        assert.equal(agentIdentifier, "reviewer");
        assert.equal(task, "Audit failing tests");
        return {
          sessionId: "session-123",
        };
      },
      readPaneOutput: async () => ({
        output: "assistant: Reviewed failing tests and proposed a fix\n__SUBAGENT_DONE_0__",
      }),
    });

    const result = await handlers.copilotSubagentLaunch({
      workspacePath,
      requestedIdentifier: "reviewer",
      task: "Audit failing tests",
      enumerateCustomAgents: async () => [{ identifier: "reviewer" }],
      awaitCompletion: true,
    });

    const stored = await createStateStore({ workspacePath }).readLaunchRecord(result.launchId);

    assert.equal(openPaneCalls, 1);
    assert.deepEqual(result, {
      ok: true,
      launchId: stored.launchId,
      status: "success",
      agentIdentifier: "reviewer",
      agentKind: "custom",
      backend: "tmux",
      launchAction: "attach",
      paneId: "%1",
      paneVisible: true,
      sessionId: "session-123",
      summary: "Reviewed failing tests and proposed a fix",
      summarySource: "assistant-message",
      exitCode: 0,
      metadataVersion: 2,
      resumePointer: {
        launchId: stored.launchId,
        sessionId: "session-123",
        agentIdentifier: "reviewer",
        backend: "tmux",
        paneId: "%1",
        manifestPath: path.join(
          workspacePath,
          ".copilot-interactive-subagents",
          "launches",
          `${stored.launchId}.json`,
        ),
      },
    });
    assert.equal(stored.status, "success");
    assert.equal(stored.summary, "Reviewed failing tests and proposed a fix");
    assert.equal(stored.exitCode, 0);
  });

  it("GIVEN the default-wired entrypoint services WHEN launch runs with request runtime adapters THEN it performs Slice 1 work instead of returning ready-to-launch", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );

    let starts = 0;
    let openPaneCalls = 0;
    let launchCalls = 0;
    let readCalls = 0;
    const handlers = await createExtensionHandlers();

    const result = await handlers.copilotSubagentLaunch({
      workspacePath,
      requestedBackend: "tmux",
      requestedIdentifier: "reviewer",
      task: "Verify default wiring",
      enumerateCustomAgents: async () => [{ identifier: "reviewer" }],
      env: {},
      hasCommand: (command) => command === "tmux",
      startupSupport: {
        cmux: false,
        tmux: true,
        zellij: false,
      },
      start: async (backend) => {
        starts += 1;
        assert.equal(backend, "tmux");
        return {
          sessionName: "copilot-interactive-subagents",
        };
      },
      launchRuntime: {
        openPane: async ({ backend, launchAction, visible }) => {
          openPaneCalls += 1;
          assert.equal(backend, "tmux");
          assert.equal(launchAction, "start");
          assert.equal(visible, true);
          return {
            paneId: "%4",
            visible: true,
          };
        },
        launchAgentInPane: async ({ paneId, agentIdentifier, task }) => {
          launchCalls += 1;
          assert.equal(paneId, "%4");
          assert.equal(agentIdentifier, "reviewer");
          assert.equal(task, "Verify default wiring");
          return {
            sessionId: "session-default",
          };
        },
        readPaneOutput: async ({ paneId, sessionId }) => {
          readCalls += 1;
          assert.equal(paneId, "%4");
          assert.equal(sessionId, "session-default");
          return {
            output: "assistant: Default-wired launch succeeded\n__SUBAGENT_DONE_0__",
          };
        },
      },
    });

    assert.equal(starts, 1);
    assert.equal(openPaneCalls, 1);
    assert.equal(launchCalls, 1);
    assert.equal(readCalls, 1);
    assert.notEqual(result.status, "ready-to-launch");
    assert.equal(result.status, "success");
    assert.equal(result.launchAction, "start");
    assert.equal(result.paneId, "%4");
    assert.equal(result.sessionId, "session-default");
    assert.equal(result.summary, "Default-wired launch succeeded");
  });

  it("GIVEN default monitor settings WHEN the child sentinel arrives after roughly half a minute of polling THEN launch still succeeds instead of timing out", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { launchSingleSubagent } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/launch.mjs",
      ["launchSingleSubagent"],
    );
    const { createStateStore } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createStateStore"],
    );

    const attempts = [];
    const result = await launchSingleSubagent({
      request: {
        workspacePath,
        task: "Wait for a slower child turn",
        sleep: async () => {},
      },
      agentValidation: {
        identifier: "github-copilot",
        agentKind: "builtin",
      },
      backendResolution: {
        selectedBackend: "tmux",
        action: "attach",
      },
      services: {
        stateStore: createStateStore({ workspacePath }),
        openPane: async () => ({
          paneId: "%33",
          visible: true,
        }),
        launchAgentInPane: async () => ({
          sessionId: "session-slower-child",
        }),
        readPaneOutput: async ({ attempt }) => {
          attempts.push(attempt);

          if (attempt < 64) {
            return {
              output: `assistant: still working (${attempt})`,
            };
          }

          return {
            output: "assistant: TMUX_E2E_OK\n__SUBAGENT_DONE_0__",
          };
        },
      },
    });

    assert.equal(result.status, "success");
    assert.equal(result.summary, "TMUX_E2E_OK");
    assert.equal(result.exitCode, 0);
    assert.equal(attempts.length, 65);
  });

  it("GIVEN an attached zellij backend WHEN the default launch path is used THEN explicit backend zellij resolves through attach instead of BACKEND_START_UNSUPPORTED", async () => {
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );

    const handlers = await createExtensionHandlers({
      continueLaunch: async ({ request, agentValidation, backendResolution }) => ({
        status: "ready-to-launch",
        agentIdentifier: agentValidation.identifier,
        backend: backendResolution.selectedBackend,
        launchAction: backendResolution.action,
        task: request.task,
      }),
    });

    const result = await handlers.copilotSubagentLaunch({
      requestedBackend: "zellij",
      requestedIdentifier: "reviewer",
      task: "Verify attached zellij backend selection",
      enumerateCustomAgents: async () => [{ identifier: "reviewer" }],
      env: {
        ZELLIJ: "0",
        ZELLIJ_PANE_ID: "0",
        ZELLIJ_SESSION_NAME: "copilot-zellij-test",
      },
      hasCommand: (command) => command === "zellij",
    });

    assert.deepEqual(result, {
      status: "ready-to-launch",
      agentIdentifier: "reviewer",
      backend: "zellij",
      launchAction: "attach",
      task: "Verify attached zellij backend selection",
    });
  });

  it("writes the optional project-local launch index during launch lifecycle updates", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );
    const { createStateStore } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createStateStore"],
    );
    const { createStateIndex } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state-index.mjs",
      ["createStateIndex"],
    );

    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({
        ok: true,
        selectedBackend: "tmux",
        action: "attach",
        manualSetupRequired: false,
      }),
      createStateStore: (request) => createStateStore({ workspacePath: request.workspacePath }),
      createStateIndex: (request) => createStateIndex({ projectRoot: request.projectRoot }),
      openPane: async () => ({
        paneId: "%11",
        visible: true,
      }),
      launchAgentInPane: async () => ({
        sessionId: "session-idx",
      }),
      readPaneOutput: async () => ({
        output: "assistant: Indexed launch complete\n__SUBAGENT_DONE_0__",
      }),
    });

    const result = await handlers.copilotSubagentLaunch({
      workspacePath,
      projectRoot: workspacePath,
      requestedIdentifier: "reviewer",
      task: "Persist launch index metadata",
      enumerateCustomAgents: async () => [{ identifier: "reviewer" }],
      awaitCompletion: true,
    });

    const indexed = await createStateIndex({ projectRoot: workspacePath }).lookupLaunch(result.launchId);

    assert.equal(indexed.launchId, result.launchId);
    assert.equal(indexed.status, "success");
    assert.equal(indexed.summary, "Indexed launch complete");
    assert.match(indexed.manifestPath, new RegExp(`${result.launchId}\\.json$`));
  });

  it("GIVEN the optional project-local index write fails WHEN launch succeeds THEN the workspace manifest remains authoritative", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );
    const { createStateStore } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createStateStore"],
    );

    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({
        ok: true,
        selectedBackend: "tmux",
        action: "attach",
        manualSetupRequired: false,
      }),
      createStateStore: (request) => createStateStore({ workspacePath: request.workspacePath }),
      stateIndex: {
        async writeLaunchIndexEntry() {
          throw new Error("project-local index unavailable");
        },
      },
      openPane: async () => ({
        paneId: "%12",
        visible: true,
      }),
      launchAgentInPane: async () => ({
        sessionId: "session-best-effort",
      }),
      readPaneOutput: async () => ({
        output: "assistant: Launch stayed successful without index sync\n__SUBAGENT_DONE_0__",
      }),
    });

    const result = await handlers.copilotSubagentLaunch({
      workspacePath,
      requestedIdentifier: "reviewer",
      task: "Ignore project-local index failures",
      enumerateCustomAgents: async () => [{ identifier: "reviewer" }],
      awaitCompletion: true,
    });

    const stored = await createStateStore({ workspacePath }).readLaunchRecord(result.launchId);

    assert.equal(result.ok, true);
    assert.equal(result.status, "success");
    assert.equal(result.summary, "Launch stayed successful without index sync");
    assert.equal(stored.status, "success");
    assert.equal(stored.sessionId, "session-best-effort");
  });

  it("GIVEN only low-level default adapter dependencies are injected WHEN launch runs without pane overrides THEN the default entrypoint wiring performs a real launch flow", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );
    const { createStateStore } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createStateStore"],
    );

    const calls = [];
    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({
        ok: true,
        selectedBackend: "tmux",
        action: "attach",
        manualSetupRequired: false,
      }),
      createStateStore: (request) => createStateStore({ workspacePath: request.workspacePath }),
      runBackendCommand: async ({ command, args }) => {
        calls.push({ command, args });

        if (command !== "tmux") {
          assert.fail(`unexpected backend command: ${command}`);
        }

        if (args[0] === "split-window") {
          return { stdout: "%9\n" };
        }

        if (args[0] === "select-pane" || args[0] === "send-keys") {
          return { stdout: "" };
        }

        if (args[0] === "capture-pane") {
          return {
            stdout: "assistant: Default adapter launch completed\n__SUBAGENT_DONE_0__",
          };
        }

        assert.fail(`unexpected tmux args: ${args.join(" ")}`);
      },
      createAgentLaunchCommand: ({ agentIdentifier, task }) => {
        assert.equal(agentIdentifier, "reviewer");
        assert.equal(task, "Use concrete default adapters");
        return "printf 'assistant: Default adapter launch completed\\n__SUBAGENT_DONE_0__\\n'";
      },
    });

    const result = await handlers.copilotSubagentLaunch({
      workspacePath,
      requestedIdentifier: "reviewer",
      task: "Use concrete default adapters",
      enumerateCustomAgents: async () => [{ identifier: "reviewer" }],
      awaitCompletion: true,
    });

    assert.equal(result.status, "success");
    assert.notEqual(result.status, "ready-to-launch");
    assert.equal(result.paneId, "%9");
    assert.equal(result.summary, "Default adapter launch completed");
    assert.ok(calls.some(({ args }) => args[0] === "split-window"));
    assert.ok(calls.some(({ args }) => args[0] === "send-keys"));
    assert.ok(calls.some(({ args }) => args[0] === "capture-pane"));
  });

  it("GIVEN default runtime wiring for zellij WHEN a single launch is attempted THEN it uses zellij pane operations to open a visible pane and send the child command", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );

    const calls = [];
    const launchCommand = "printf 'assistant: Zellij adapter launch queued\\n__SUBAGENT_DONE_0__\\n'";
    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({
        ok: true,
        selectedBackend: "zellij",
        action: "attach",
        manualSetupRequired: false,
      }),
      runBackendCommand: async ({ command, args }) => {
        calls.push({ command, args });

        if (command !== "zellij") {
          assert.fail(`unexpected backend command: ${command}`);
        }

        if (args[0] === "action" && args[1] === "new-pane") {
          return { stdout: "pane:42\n" };
        }

        if (args[0] === "action" && args[1] === "write-chars" && /ZELLIJ_PANE_ID/.test(args[2] ?? "")) {
          const match = args[2].match(/>\s*(['"]?)(.+?)\1$/);
          if (match) {
            await writeFile(match[2], "42\n", "utf8");
          }
          return { stdout: "" };
        }

        if (args[0] === "action" && args[1] === "write" && args[2] === "13") {
          return { stdout: "" };
        }

        if (args[0] === "action" && args[1] === "write-chars") {
          return { stdout: "" };
        }

        assert.fail(`unexpected zellij args: ${args.join(" ")}`);
      },
      createAgentLaunchCommand: ({ agentIdentifier, task }) => {
        assert.equal(agentIdentifier, "reviewer");
        assert.equal(task, "Use zellij default adapters");
        return launchCommand;
      },
    });

    const result = await handlers.copilotSubagentLaunch({
      workspacePath,
      requestedIdentifier: "reviewer",
      task: "Use zellij default adapters",
      enumerateCustomAgents: async () => [{ identifier: "reviewer" }],
      awaitCompletion: false,
    });

    assert.equal(result.status, "running");
    assert.equal(result.backend, "zellij");
    assert.equal(result.launchAction, "attach");
    assert.ok(calls.some(({ args }) => args[0] === "action" && args[1] === "new-pane"));
    assert.ok(calls.some(({ args }) => args[0] === "action" && args[1] === "write-chars" && args[2] === launchCommand));
    assert.ok(calls.some(({ args }) => args[0] === "action" && args[1] === "write" && args[2] === "13"));
  });

  it("GIVEN zellij new-pane omits a pane id WHEN the default launch path runs THEN launch metadata falls back to the pane-id temp file flow", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );

    const calls = [];
    let launchEnv = null;
    const launchCommand = "printf 'assistant: Zellij fallback launch queued\\n__SUBAGENT_DONE_0__\\n'";
    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({
        ok: true,
        selectedBackend: "zellij",
        action: "attach",
        manualSetupRequired: false,
      }),
      runBackendCommand: async ({ command, args, env }) => {
        calls.push({ command, args });

        if (command !== "zellij") {
          assert.fail(`unexpected backend command: ${command}`);
        }

        if (args[0] === "action" && args[1] === "new-pane") {
          return { stdout: "" };
        }

        // New flow: zellij run with bash -c script that writes pane ID
        if (args[0] === "run") {
          const scriptArg = args[args.length - 1];
          const match = scriptArg.match(/>\s*(['"]?)(.+?)\1\s*&&/);
          if (match) {
            await writeFile(match[2], "84\n", "utf8");
          }
          return { stdout: "" };
        }

        if (args[0] === "action" && args[1] === "write-chars" && args[2] === launchCommand) {
          launchEnv = env;
          return { stdout: "" };
        }

        if (args[0] === "action" && args[1] === "write" && args[2] === "13") {
          return { stdout: "" };
        }

        assert.fail(`unexpected zellij args: ${args.join(" ")}`);
      },
      createAgentLaunchCommand: ({ agentIdentifier, task }) => {
        assert.equal(agentIdentifier, "reviewer");
        assert.equal(task, "Use zellij pane-id fallback");
        return launchCommand;
      },
    });

    const result = await handlers.copilotSubagentLaunch({
      workspacePath,
      requestedIdentifier: "reviewer",
      task: "Use zellij pane-id fallback",
      enumerateCustomAgents: async () => [{ identifier: "reviewer" }],
      awaitCompletion: false,
      env: {
        ZELLIJ: "0",
        ZELLIJ_SESSION_NAME: "copilot-zellij-test",
        ZELLIJ_PANE_ID: "5",
      },
    });

    assert.equal(result.status, "running");
    assert.equal(result.backend, "zellij");
    assert.equal(result.paneId, "pane:84");
    assert.equal(calls[0]?.args[1], "new-pane");
    const runIndex = calls.findIndex(({ args }) => args[0] === "run");
    assert.ok(runIndex >= 0, "should have called zellij run for pane-id capture");
    assert.equal(launchEnv?.ZELLIJ_PANE_ID, "84");
  });

  it("GIVEN zellij default launch falls back to pane-id temp-file capture AND the temp file exists empty before the pane id is written WHEN launch proceeds THEN it still reaches running with the captured pane id", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );

    const calls = [];
    const launchCommand = "printf 'assistant: Zellij fallback race launch queued\\n__SUBAGENT_DONE_0__\\n'";
    let delayedPaneIdWrite = Promise.resolve();
    t.after(async () => {
      await delayedPaneIdWrite;
    });

    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({
        ok: true,
        selectedBackend: "zellij",
        action: "attach",
        manualSetupRequired: false,
      }),
      runBackendCommand: async ({ command, args }) => {
        calls.push({ command, args });

        if (command !== "zellij") {
          assert.fail(`unexpected backend command: ${command}`);
        }

        if (args[0] === "action" && args[1] === "new-pane") {
          return { stdout: "" };
        }

        // Simulate delayed pane ID write (race condition)
        if (args[0] === "run") {
          const scriptArg = args[args.length - 1];
          const match = scriptArg.match(/>\s*(['"]?)(.+?)\1\s*&&/);
          if (match) {
            await writeFile(match[2], "", "utf8");
            delayedPaneIdWrite = new Promise((resolve) => {
              setTimeout(() => {
                writeFile(match[2], "84\n", "utf8")
                  .then(() => resolve())
                  .catch(() => resolve());
              }, 50);
            });
          }
          return { stdout: "" };
        }

        if (args[0] === "action" && args[1] === "write-chars" && args[2] === launchCommand) {
          return { stdout: "" };
        }

        if (args[0] === "action" && args[1] === "write" && args[2] === "13") {
          return { stdout: "" };
        }

        assert.fail(`unexpected zellij args: ${args.join(" ")}`);
      },
      createAgentLaunchCommand: ({ agentIdentifier, task }) => {
        assert.equal(agentIdentifier, "reviewer");
        assert.equal(task, "Use zellij pane-id fallback race");
        return launchCommand;
      },
    });

    const result = await handlers.copilotSubagentLaunch({
      workspacePath,
      requestedIdentifier: "reviewer",
      task: "Use zellij pane-id fallback race",
      enumerateCustomAgents: async () => [{ identifier: "reviewer" }],
      awaitCompletion: false,
    });

    assert.equal(result.status, "running");
    assert.equal(result.backend, "zellij");
    assert.equal(result.paneId, "pane:84");
    const runIndex = calls.findIndex(({ args }) => args[0] === "run");
    assert.ok(runIndex >= 0, "should have called zellij run for pane-id capture");
  });

  it("GIVEN default zellij runtime monitoring and awaitCompletion WHEN pane output contains a completion sentinel and summary THEN launch succeeds without using an invalid dump-screen pane-id flag", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );

    const calls = [];
    let dumpScreenEnv = null;
    const launchCommand = "printf 'assistant: Zellij monitor path queued\\n__SUBAGENT_DONE_0__\\n'";
    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({
        ok: true,
        selectedBackend: "zellij",
        action: "attach",
        manualSetupRequired: false,
      }),
      runBackendCommand: async ({ command, args, env }) => {
        calls.push({ command, args });

        if (command !== "zellij") {
          assert.fail(`unexpected backend command: ${command}`);
        }

        if (args[0] === "action" && args[1] === "new-pane") {
          return { stdout: "pane:42\n" };
        }

        if (args[0] === "action" && args[1] === "write-chars" && args[2] === launchCommand) {
          return { stdout: "" };
        }

        if (args[0] === "action" && args[1] === "write" && args[2] === "13") {
          return { stdout: "" };
        }

        if (args[0] === "action" && args[1] === "dump-screen") {
          dumpScreenEnv = env;
          if (args.includes("--pane-id")) {
            throw new Error(`zellij rejected invalid dump-screen invocation: ${args.join(" ")}`);
          }

          const outputPath = args.find((value) => /copilot-subagents-zellij-screen/.test(String(value)));
          if (!outputPath) {
            throw new Error(`expected dump-screen output path in: ${args.join(" ")}`);
          }

          await writeFile(
            outputPath,
            "assistant: Zellij monitor path succeeded\n__SUBAGENT_DONE_0__\n",
            "utf8",
          );
          return { stdout: "" };
        }

        assert.fail(`unexpected zellij args: ${args.join(" ")}`);
      },
      createAgentLaunchCommand: ({ agentIdentifier, task }) => {
        assert.equal(agentIdentifier, "reviewer");
        assert.equal(task, "Use zellij monitor path");
        return launchCommand;
      },
    });

    const result = await handlers.copilotSubagentLaunch({
      workspacePath,
      requestedIdentifier: "reviewer",
      task: "Use zellij monitor path",
      enumerateCustomAgents: async () => [{ identifier: "reviewer" }],
      awaitCompletion: true,
    });

    const dumpScreenCall = calls.find(({ args }) => args[0] === "action" && args[1] === "dump-screen");

    assert.ok(dumpScreenCall, "expected zellij dump-screen monitoring call");
    assert.ok(
      !dumpScreenCall.args.includes("--pane-id"),
      `invalid zellij dump-screen invocation: ${dumpScreenCall.args.join(" ")}`,
    );
    assert.equal(dumpScreenEnv?.ZELLIJ_PANE_ID, "42");
    assert.equal(result.status, "success");
    assert.equal(result.backend, "zellij");
    assert.equal(result.paneId, "pane:42");
    assert.equal(result.summary, "Zellij monitor path succeeded");
  });

  it("GIVEN the built-in default Copilot agent WHEN the default launch command is built THEN it omits --agent and uses the base prompt mode", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );

    const calls = [];
    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({
        ok: true,
        selectedBackend: "tmux",
        action: "attach",
        manualSetupRequired: false,
      }),
      runBackendCommand: async ({ command, args }) => {
        calls.push({ command, args });

        if (args[0] === "split-window") {
          return { stdout: "%14\n" };
        }

        if (args[0] === "select-pane" || args[0] === "send-keys") {
          return { stdout: "" };
        }

        if (args[0] === "capture-pane") {
          return {
            stdout: "assistant: SUBAGENT_OK\n__SUBAGENT_DONE_0__",
          };
        }

        assert.fail(`unexpected tmux args: ${args.join(" ")}`);
      },
    });

    const result = await handlers.copilotSubagentLaunch({
      workspacePath,
      agentIdentifier: "github-copilot",
      task: "Respond with exactly SUBAGENT_OK",
      enumerateCustomAgents: async () => [],
      awaitCompletion: true,
    });

    const typedCommand = calls.find(({ args }) => args[0] === "send-keys" && args[3] === "-l")?.args[4] ?? "";

    assert.equal(result.status, "success");
    assert.match(typedCommand, /COPILOT_SUBAGENT_TASK_B64=/);
    assert.doesNotMatch(typedCommand, /--agent/);
  });

  it("GIVEN pane creation succeeds but child launch fails immediately WHEN orchestration handles the error THEN it preserves failure state and inspectable metadata", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );
    const { createStateStore } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createStateStore"],
    );

    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({
        ok: true,
        selectedBackend: "tmux",
        action: "start",
        manualSetupRequired: false,
      }),
      createStateStore: (request) => createStateStore({ workspacePath: request.workspacePath }),
      openPane: async () => ({
        paneId: "%2",
        visible: true,
      }),
      launchAgentInPane: async () => {
        const error = new Error("child copilot launch failed");
        error.exitCode = 17;
        throw error;
      },
    });

    const result = await handlers.copilotSubagentLaunch({
      workspacePath,
      requestedIdentifier: "reviewer",
      task: "Draft a summary",
      enumerateCustomAgents: async () => [{ identifier: "reviewer" }],
    });

    const stored = await createStateStore({ workspacePath }).readLaunchRecord(result.launchId);

    assert.equal(result.ok, false);
    assert.equal(result.status, "failure");
    assert.equal(result.paneId, "%2");
    assert.equal(result.exitCode, 17);
    assert.match(result.summary, /failed/i);
    assert.match(result.summary, /%2/);
    assert.equal(stored.status, "failure");
    assert.equal(stored.paneId, "%2");
    assert.equal(stored.exitCode, 17);
    assert.equal(stored.summary, result.summary);
  });

  it("GIVEN launch metadata is written before completion WHEN the parent session exits and returns later THEN the unfinished launch record remains readable for inspection", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );
    const { createStateStore } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createStateStore"],
    );

    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({
        ok: true,
        selectedBackend: "tmux",
        action: "attach",
        manualSetupRequired: false,
      }),
      createStateStore: (request) => createStateStore({ workspacePath: request.workspacePath }),
      openPane: async () => ({
        paneId: "%3",
        visible: true,
      }),
      launchAgentInPane: async () => ({
        sessionId: "session-789",
      }),
      readPaneOutput: async () => {
        assert.fail("pane monitoring should not run when awaitCompletion is false");
      },
    });

    const result = await handlers.copilotSubagentLaunch({
      workspacePath,
      requestedIdentifier: "reviewer",
      task: "Continue in background",
      enumerateCustomAgents: async () => [{ identifier: "reviewer" }],
      awaitCompletion: false,
    });

    const laterStateStore = createStateStore({ workspacePath });
    const stored = await laterStateStore.readLaunchRecord(result.launchId);

    assert.equal(result.ok, true);
    assert.equal(result.status, "running");
    assert.equal(result.summarySource, "fallback");
    assert.match(result.summary, /running/i);
    assert.deepEqual(stored, {
      launchId: result.launchId,
      agentIdentifier: "reviewer",
      agentKind: "custom",
      backend: "tmux",
      paneId: "%3",
      sessionId: "session-789",
      requestedAt: stored.requestedAt,
      status: "running",
      summary: null,
      exitCode: null,
      metadataVersion: 2,
      copilotSessionId: stored.copilotSessionId,
      interactive: false,
      fork: null,
      closePaneOnCompletion: true,
      eventsBaseline: null,
    });
  });
});
