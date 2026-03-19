import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { importProjectModule } from "./helpers/red-harness.mjs";

describe("agent discovery and exact-name validation", () => {
  it("GIVEN runtime agent enumeration WHEN listing runs THEN it returns exact runtime-recognized identifiers without aliases", async () => {
    const { listRuntimeAgents } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/agents.mjs",
      ["listRuntimeAgents"],
    );

    const result = await listRuntimeAgents({
      enumerateCustomAgents: async () => [
        { identifier: "reviewer" },
        { identifier: "planner" },
        { identifier: "reviewer" },
      ],
      builtInIdentifiers: ["github-copilot"],
    });

    assert.deepEqual(result, {
      runtimeRecognizedIdentifiers: ["planner", "reviewer"],
      builtInIdentifiersAcceptedExplicitly: ["github-copilot"],
      exactNameOnly: true,
    });
  });

  it("GIVEN an exact custom-agent identifier WHEN validation runs THEN the identifier is accepted unchanged", async () => {
    const { validateAgentIdentifier } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/agents.mjs",
      ["validateAgentIdentifier"],
    );

    const result = await validateAgentIdentifier({
      requestedIdentifier: "reviewer",
      enumerateCustomAgents: async () => [
        { identifier: "reviewer" },
        { identifier: "worker" },
      ],
      builtInIdentifiers: ["github-copilot"],
    });

    assert.deepEqual(result, {
      ok: true,
      identifier: "reviewer",
      agentKind: "custom",
      validationMethod: "runtime-enumeration",
    });
  });

  it("GIVEN aliases, fuzzy text, or role inference WHEN validation runs THEN they are rejected with AGENT_NOT_FOUND", async () => {
    const { validateAgentIdentifier } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/agents.mjs",
      ["validateAgentIdentifier"],
    );

    for (const requestedIdentifier of ["Reviewer", "review", "code reviewer"]) {
      const result = await validateAgentIdentifier({
        requestedIdentifier,
        enumerateCustomAgents: async () => [{ identifier: "reviewer" }],
        builtInIdentifiers: ["github-copilot"],
      });

      assert.equal(result.ok, false);
      assert.equal(result.code, "AGENT_NOT_FOUND");
      assert.equal(result.requestedIdentifier, requestedIdentifier);
      assert.deepEqual(result.availableIdentifiers, ["reviewer", "github-copilot"]);
    }
  });

  it("GIVEN a built-in identifier cannot be enumerated at runtime WHEN it is requested explicitly THEN validation still accepts it", async () => {
    const { validateAgentIdentifier } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/agents.mjs",
      ["validateAgentIdentifier"],
    );

    const result = await validateAgentIdentifier({
      requestedIdentifier: "github-copilot",
      enumerateCustomAgents: async () => [{ identifier: "reviewer" }],
      builtInIdentifiers: ["github-copilot"],
    });

    assert.deepEqual(result, {
      ok: true,
      identifier: "github-copilot",
      agentKind: "built-in",
      validationMethod: "explicit-built-in",
    });
  });

  it("GIVEN runtime validation is unavailable WHEN a non-built-in identifier is requested THEN a stable validation-unavailable error is returned", async () => {
    const { validateAgentIdentifier } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/agents.mjs",
      ["validateAgentIdentifier"],
    );

    const result = await validateAgentIdentifier({
      requestedIdentifier: "reviewer",
      enumerateCustomAgents: async () => {
        throw new Error("agent rpc unavailable");
      },
      builtInIdentifiers: ["github-copilot"],
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "AGENT_VALIDATION_UNAVAILABLE");
    assert.equal(result.requestedIdentifier, "reviewer");
    assert.deepEqual(result.availableIdentifiers, ["github-copilot"]);
    assert.match(result.message, /agent rpc unavailable/);
  });

  it("GIVEN the default handler wiring WHEN an explicit built-in identifier is launched THEN the built-in allowlist is applied without caller-supplied builtInIdentifiers", async () => {
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );

    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({
        ok: true,
        selectedBackend: "tmux",
        action: "start",
        manualSetupRequired: false,
      }),
      continueLaunch: async ({ request, agentValidation, backendResolution }) => ({
        status: "ready-to-launch",
        agentIdentifier: agentValidation.identifier,
        backend: backendResolution.selectedBackend,
        launchAction: backendResolution.action,
        task: request.task,
      }),
    });

    const result = await handlers.copilotSubagentLaunch({
      agentIdentifier: "github-copilot",
      task: "Verify built-in default allowlist",
      enumerateCustomAgents: async () => [],
    });

    assert.deepEqual(result, {
      status: "ready-to-launch",
      agentIdentifier: "github-copilot",
      backend: "tmux",
      launchAction: "start",
      task: "Verify built-in default allowlist",
    });
  });

  it("GIVEN launch prerequisites succeed WHEN the entrypoint handles a launch request THEN it continues with the validated agent and selected backend", async () => {
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );

    const handlers = await createExtensionHandlers({
      validateAgentIdentifier: async () => ({
        ok: true,
        identifier: "github-copilot",
        agentKind: "built-in",
        validationMethod: "explicit-built-in",
      }),
      resolveLaunchBackend: async () => ({
        ok: true,
        selectedBackend: "tmux",
        action: "start",
        manualSetupRequired: false,
      }),
      continueLaunch: async ({ request, agentValidation, backendResolution }) => ({
        status: "ready-to-launch",
        agentIdentifier: agentValidation.identifier,
        backend: backendResolution.selectedBackend,
        launchAction: backendResolution.action,
        task: request.task,
      }),
    });

    const result = await handlers.copilotSubagentLaunch({
      agentIdentifier: "github-copilot",
      task: "Audit failing tests",
      interactive: false,
    });

    assert.deepEqual(result, {
      status: "ready-to-launch",
      agentIdentifier: "github-copilot",
      backend: "tmux",
      launchAction: "start",
      task: "Audit failing tests",
    });
  });

  it("GIVEN the default launch wiring WHEN a request uses agentIdentifier THEN the entrypoint normalizes it for exact-name validation", async () => {
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );

    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({
        ok: true,
        selectedBackend: "tmux",
        action: "start",
        manualSetupRequired: false,
      }),
      continueLaunch: async ({ request, agentValidation, backendResolution }) => ({
        status: "ready-to-launch",
        agentIdentifier: agentValidation.identifier,
        backend: backendResolution.selectedBackend,
        launchAction: backendResolution.action,
        task: request.task,
      }),
    });

    const result = await handlers.copilotSubagentLaunch({
      agentIdentifier: "reviewer",
      task: "Inspect launch wiring",
      interactive: false,
      enumerateCustomAgents: async () => [{ identifier: "reviewer" }],
      builtInIdentifiers: ["github-copilot"],
    });

    assert.deepEqual(result, {
      status: "ready-to-launch",
      agentIdentifier: "reviewer",
      backend: "tmux",
      launchAction: "start",
      task: "Inspect launch wiring",
    });
  });

  it("GIVEN built-in runtime enumeration is unavailable WHEN launch uses agentIdentifier THEN the entrypoint still validates an explicit built-in identifier", async () => {
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );

    const handlers = await createExtensionHandlers({
      resolveLaunchBackend: async () => ({
        ok: true,
        selectedBackend: "tmux",
        action: "start",
        manualSetupRequired: false,
      }),
      continueLaunch: async ({ request, agentValidation, backendResolution }) => ({
        status: "ready-to-launch",
        agentIdentifier: agentValidation.identifier,
        backend: backendResolution.selectedBackend,
        launchAction: backendResolution.action,
        task: request.task,
      }),
    });

    const result = await handlers.copilotSubagentLaunch({
      agentIdentifier: "github-copilot",
      task: "Inspect built-in validation",
      interactive: false,
      enumerateCustomAgents: async () => {
        throw new Error("agent rpc unavailable");
      },
      builtInIdentifiers: ["github-copilot"],
    });

    assert.deepEqual(result, {
      status: "ready-to-launch",
      agentIdentifier: "github-copilot",
      backend: "tmux",
      launchAction: "start",
      task: "Inspect built-in validation",
    });
  });

  it("GIVEN agent validation fails WHEN launch is requested THEN the entrypoint returns the structured validation error without continuing", async () => {
    const { createExtensionHandlers } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["createExtensionHandlers"],
    );

    let continueCalls = 0;
    const handlers = await createExtensionHandlers({
      validateAgentIdentifier: async () => ({
        ok: false,
        code: "AGENT_NOT_FOUND",
        requestedIdentifier: "planner",
        availableIdentifiers: ["reviewer", "github-copilot"],
      }),
      resolveLaunchBackend: async () => {
        assert.fail("launch should not resolve a backend after agent validation fails.");
      },
      continueLaunch: async () => {
        continueCalls += 1;
      },
    });

    const result = await handlers.copilotSubagentLaunch({
      agentIdentifier: "planner",
      task: "Draft a plan",
      interactive: true,
    });

    assert.equal(continueCalls, 0);
    assert.deepEqual(result, {
      ok: false,
      code: "AGENT_NOT_FOUND",
      requestedIdentifier: "planner",
      availableIdentifiers: ["reviewer", "github-copilot"],
      field: "agentIdentifier",
      guidance:
        "Provide the exact runtime-recognized agent identifier. Use copilot_subagent_list_agents to discover valid names.",
    });
  });
});
