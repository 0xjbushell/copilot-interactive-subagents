import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { importProjectModule } from "./helpers/red-harness.mjs";

async function createWorkspace(t) {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "copilot-interactive-subagents-tool-interface-"));
  t.after(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  return workspacePath;
}

function extractSection(document, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`### \`${escapedHeading}\`([\\s\\S]*?)(?:\\n### \`|\\n## |$)`);
  const match = document.match(pattern);
  assert.ok(match, `Expected documentation section for ${heading}`);
  return match[1];
}

describe("generic tool interface and operator handoff", () => {
  it("exports a documented public tool surface with namespaced tool names", async () => {
    const { PUBLIC_TOOL_NAMES, PUBLIC_TOOL_DEFINITIONS } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/extension.mjs",
      ["PUBLIC_TOOL_NAMES", "PUBLIC_TOOL_DEFINITIONS"],
    );

    assert.deepEqual(PUBLIC_TOOL_NAMES, [
      "copilot_subagent_list_agents",
      "copilot_subagent_launch",
      "copilot_subagent_parallel",
      "copilot_subagent_resume",
      "copilot_subagent_set_title",
    ]);
    assert.deepEqual(
      PUBLIC_TOOL_DEFINITIONS.map((definition) => definition.name),
      PUBLIC_TOOL_NAMES,
    );
    assert.ok(PUBLIC_TOOL_DEFINITIONS.every((definition) => definition.requestShape));
    assert.ok(PUBLIC_TOOL_DEFINITIONS.every((definition) => definition.resultShape));
  });

  it("registers namespaced handlers and preserves camelCase aliases for existing callers", async () => {
    const { createExtensionHandlers, PUBLIC_TOOL_NAMES } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/extension.mjs",
      ["createExtensionHandlers", "PUBLIC_TOOL_NAMES"],
    );

    const handlers = await createExtensionHandlers({
      listRuntimeAgents: async () => ({
        runtimeRecognizedIdentifiers: ["reviewer"],
        builtInIdentifiersAcceptedExplicitly: ["github-copilot"],
        exactNameOnly: true,
      }),
      discoverLaunchBackends: async () => [],
      validateAgentIdentifier: async ({ requestedIdentifier }) => ({
        ok: true,
        identifier: requestedIdentifier,
        agentKind: "custom",
      }),
      resolveLaunchBackend: async () => ({
        ok: true,
        selectedBackend: "tmux",
        action: "attach",
        manualSetupRequired: false,
      }),
      continueLaunch: async ({ request, agentValidation, backendResolution }) => ({
        ok: true,
        launchId: "launch-001",
        status: "running",
        agentIdentifier: agentValidation.identifier,
        agentKind: agentValidation.agentKind,
        backend: backendResolution.selectedBackend,
        launchAction: backendResolution.action,
        paneId: "%1",
        paneVisible: true,
        sessionId: null,
        summary: request.task,
        summarySource: "fallback",
        exitCode: null,
        metadataVersion: 3,
        resumePointer: null,
      }),
      continueParallelLaunch: async () => ({
        aggregateStatus: "success",
        results: [],
        progressByLaunchId: {},
      }),
      continueResume: async () => ({
        ok: true,
        launchId: "launch-001",
        status: "running",
        agentIdentifier: "reviewer",
        agentKind: "custom",
        backend: "tmux",
        paneId: "%1",
        paneVisible: true,
        sessionId: "session-1",
        summary: "running",
        summarySource: "fallback",
        exitCode: null,
        metadataVersion: 3,
        resumePointer: null,
      }),
      continueSetTitle: async () => ({
        ok: true,
        backend: "tmux",
        paneId: "%1",
        title: "Investigating",
        applied: true,
      }),
    });

    assert.ok(PUBLIC_TOOL_NAMES.every((name) => typeof handlers[name] === "function"));
    assert.equal(handlers.copilotSubagentLaunch, handlers.copilot_subagent_launch);
    assert.equal(handlers.copilotSubagentListAgents, handlers.copilot_subagent_list_agents);
    assert.equal(handlers.copilotSubagentParallel, handlers.copilot_subagent_parallel);
    assert.equal(handlers.copilotSubagentResume, handlers.copilot_subagent_resume);
    assert.equal(handlers.copilotSubagentSetTitle, handlers.copilot_subagent_set_title);
  });

  it("registers SDK tools through joinSession for live extension discovery", async () => {
    const { registerExtensionSession } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/extension.mjs",
      ["registerExtensionSession"],
    );

    let joinConfig = null;
    const session = {
      workspacePath: "/tmp/session-workspace",
      rpc: {
        agent: {
          list: async () => ({ agents: [{ identifier: "reviewer" }] }),
        },
      },
    };

    const result = await registerExtensionSession({
      joinSession: async (config) => {
        joinConfig = config;
        return session;
      },
      createHandlers: async (overrides) => {
        assert.equal(typeof overrides.sessionWorkspacePath, "function");
        return {
          copilot_subagent_list_agents: async () => ({ ok: true }),
          copilot_subagent_launch: async () => ({ ok: true }),
          copilot_subagent_parallel: async () => ({ ok: true }),
          copilot_subagent_resume: async () => ({ ok: true }),
          copilot_subagent_set_title: async () => ({ ok: true }),
        };
      },
    });

    assert.equal(result, session);
    assert.equal(joinConfig.tools.length, 10);
    assert.ok(joinConfig.tools.some((tool) => tool.name === "copilot_subagent_launch"));
    assert.ok(joinConfig.tools.some((tool) => tool.name === "copilotSubagentLaunch"));
  });

  it("returns a stable argument-validation error for malformed single-launch requests", async () => {
    const { createExtensionHandlers } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/extension.mjs",
      ["createExtensionHandlers"],
    );

    const handlers = await createExtensionHandlers();
    const result = await handlers.copilot_subagent_launch({ task: "Missing target" });

    assert.deepEqual(result, {
      ok: false,
      code: "INVALID_ARGUMENT",
      message: "agentIdentifier must be a non-empty string.",
      field: "agentIdentifier",
      guidance: "Provide the exact runtime-recognized agent identifier. Use copilot_subagent_list_agents to discover valid names.",
    });
  });

  it("returns a stable argument-validation error for malformed resume requests", async () => {
    const { createExtensionHandlers } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/extension.mjs",
      ["createExtensionHandlers"],
    );

    const handlers = await createExtensionHandlers();
    const result = await handlers.copilot_subagent_resume({
      resumeReference: { launchId: "../escape" },
    });

    assert.deepEqual(result, {
      ok: false,
      code: "INVALID_ARGUMENT",
      message: "launchId must use only letters, numbers, periods, underscores, and hyphens.",
      field: "launchId",
      guidance: "Use the launchId returned by a prior launch or resume response.",
    });
  });

  it("rejects parallel requests that mix backend targets with a stable machine-readable code", async () => {
    const { createExtensionHandlers } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/extension.mjs",
      ["createExtensionHandlers"],
    );

    const handlers = await createExtensionHandlers();
    const result = await handlers.copilot_subagent_parallel({
      launches: [
        { agentIdentifier: "reviewer-a", task: "Inspect alpha", backend: "tmux" },
        { agentIdentifier: "reviewer-b", task: "Inspect beta", backend: "zellij" },
      ],
    });

    assert.deepEqual(result, {
      ok: false,
      code: "PARALLEL_BACKEND_CONFLICT",
      message: "Parallel launches must target the same backend when a backend is specified.",
      field: "launches",
      guidance: "Use one backend for the whole batch or omit backend so the extension resolves one shared backend.",
      requestedBackends: ["tmux", "zellij"],
    });
  });

  it("routes namespaced parallel and resume tools into the dedicated services with normalized arguments", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { createExtensionHandlers } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/extension.mjs",
      ["createExtensionHandlers"],
    );

    const calls = [];
    const handlers = await createExtensionHandlers({
      listRuntimeAgents: async () => ({
        runtimeRecognizedIdentifiers: ["reviewer-a", "reviewer-b"],
        builtInIdentifiersAcceptedExplicitly: ["github-copilot"],
        exactNameOnly: true,
      }),
      validateAgentIdentifier: async ({ requestedIdentifier }) => ({
        ok: true,
        identifier: requestedIdentifier,
        agentKind: "custom",
      }),
      resolveLaunchBackend: async ({ requestedBackend }) => ({
        ok: true,
        selectedBackend: requestedBackend ?? "tmux",
        action: "attach",
        manualSetupRequired: false,
      }),
      continueParallelLaunch: async (payload) => {
        calls.push({ kind: "parallel", payload });
        return {
          aggregateStatus: "success",
          results: payload.launches.map((entry, index) => ({
            ok: true,
            launchId: `launch-00${index + 1}`,
            status: "running",
            agentIdentifier: entry.agentValidation.identifier,
            agentKind: entry.agentValidation.agentKind,
            backend: payload.backendResolution.selectedBackend,
            launchAction: payload.backendResolution.action,
            paneId: `%${index + 1}`,
            paneVisible: true,
            sessionId: null,
            summary: entry.request.task,
            summarySource: "fallback",
            exitCode: null,
            metadataVersion: 3,
            resumePointer: null,
          })),
          progressByLaunchId: {},
        };
      },
      continueResume: async (payload) => {
        calls.push({ kind: "resume", payload });
        return {
          ok: true,
          launchId: payload.request.launchId,
          status: "running",
          agentIdentifier: "reviewer-a",
          agentKind: "custom",
          backend: "tmux",
          paneId: "%1",
          paneVisible: true,
          sessionId: "session-1",
          summary: "Resumed",
          summarySource: "fallback",
          exitCode: null,
          metadataVersion: 3,
          resumePointer: { launchId: payload.request.launchId },
        };
      },
    });

    const parallelResult = await handlers.copilot_subagent_parallel({
      workspacePath,
      launches: [
        { agentIdentifier: "reviewer-a", task: "Inspect alpha" },
        { agentIdentifier: "reviewer-b", task: "Inspect beta" },
      ],
    });
    const resumeResult = await handlers.copilot_subagent_resume({
      workspacePath,
      resumeReference: { launchId: "launch-001" },
    });

    assert.equal(parallelResult.aggregateStatus, "success");
    assert.equal(calls[0].kind, "parallel");
    assert.deepEqual(
      calls[0].payload.launches.map((entry) => entry.request.requestedIdentifier),
      ["reviewer-a", "reviewer-b"],
    );
    assert.deepEqual(
      calls[0].payload.launches.map((entry) => entry.request.task),
      ["Inspect alpha", "Inspect beta"],
    );
    assert.equal(resumeResult.launchId, "launch-001");
    assert.equal(calls[1].kind, "resume");
    assert.equal(calls[1].payload.request.launchId, "launch-001");
  });

  it("documents setup, multiplexer support, exact agent targeting, parallel-write caveats, and resume expectations", async () => {
    const [readme, skillsDoc] = await Promise.all([
      readFile(path.resolve("README.md"), "utf8"),
      readFile(path.resolve("docs/skills-integration.md"), "utf8"),
    ]);
    const { PUBLIC_TOOL_DEFINITIONS } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/extension.mjs",
      ["PUBLIC_TOOL_DEFINITIONS"],
    );

    for (const toolName of [
      "copilot_subagent_list_agents",
      "copilot_subagent_launch",
      "copilot_subagent_parallel",
      "copilot_subagent_resume",
      "copilot_subagent_set_title",
    ]) {
      assert.match(readme, new RegExp(toolName));
      assert.match(skillsDoc, new RegExp(toolName));
    }

    for (const definition of PUBLIC_TOOL_DEFINITIONS) {
      const readmeSection = extractSection(readme, definition.name);
      const skillsSection = extractSection(skillsDoc, definition.name);

      for (const field of Object.keys(definition.requestShape)) {
        assert.match(readmeSection, new RegExp(field));
        assert.match(skillsSection, new RegExp(field));
      }

      for (const field of Object.keys(definition.resultShape)) {
        assert.match(readmeSection, new RegExp(field));
        assert.match(skillsSection, new RegExp(field));
      }
    }

    assert.match(readme, /tmux/i);
    assert.match(readme, /cmux/i);
    assert.match(readme, /zellij/i);
    assert.match(readme, /exact agent identifier/i);
    assert.match(readme, /parallel write/i);
    assert.match(readme, /resume/i);
    assert.match(skillsDoc, /guidance/i);
  });
});
