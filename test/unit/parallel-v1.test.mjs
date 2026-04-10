import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { importProjectModule } from "../helpers/red-harness.mjs";

describe("parallel-v1: v1 param passthrough and backend preference", () => {
  it("GIVEN parallel launch with mixed v1 params WHEN orchestration plans THEN each child gets its own params", async () => {
    const { planParallelLaunches } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/parallel.mjs",
      ["planParallelLaunches"],
    );

    const launches = [
      {
        request: {
          requestedIdentifier: "agent-a",
          task: "interactive task",
          interactive: true,
        },
        agentValidation: { ok: true, identifier: "agent-a", agentKind: "custom" },
      },
      {
        request: {
          requestedIdentifier: "agent-b",
          task: "fork task",
          fork: { copilotSessionId: "parent-uuid-123" },
        },
        agentValidation: { ok: true, identifier: "agent-b", agentKind: "custom" },
      },
      {
        request: {
          requestedIdentifier: "agent-c",
          task: "default task",
        },
        agentValidation: { ok: true, identifier: "agent-c", agentKind: "built-in" },
      },
    ];

    const backendResolution = {
      ok: true,
      selectedBackend: "tmux",
      action: "attach",
      sessionName: "test-session",
    };

    let idCounter = 0;
    const planned = planParallelLaunches({
      launches,
      backendResolution,
      createLaunchId: () => `launch-${idCounter++}`,
      now: () => "2025-01-01T00:00:00.000Z",
    });

    assert.equal(planned.length, 3);

    // Agent A: interactive — closePaneOnCompletion defaults false, awaitCompletion defaults false
    assert.equal(planned[0].plan.interactive, true);
    assert.equal(planned[0].plan.closePaneOnCompletion, false);
    assert.equal(planned[0].plan.awaitCompletion, false);

    // Agent B: fork — not interactive, closePaneOnCompletion defaults true
    assert.deepEqual(planned[1].plan.fork, { copilotSessionId: "parent-uuid-123" });
    assert.equal(planned[1].plan.interactive, false);
    assert.equal(planned[1].plan.closePaneOnCompletion, true);

    // Agent C: default — all defaults
    assert.equal(planned[2].plan.interactive, false);
    assert.equal(planned[2].plan.closePaneOnCompletion, true);
    assert.equal(planned[2].plan.fork, null);
  });

  it("GIVEN parallel launch with explicit closePaneOnCompletion override WHEN planned THEN override takes precedence", async () => {
    const { planParallelLaunches } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/parallel.mjs",
      ["planParallelLaunches"],
    );

    const launches = [
      {
        request: {
          requestedIdentifier: "agent-x",
          task: "keep pane open",
          interactive: false,
          closePaneOnCompletion: false,
        },
        agentValidation: { ok: true, identifier: "agent-x", agentKind: "custom" },
      },
    ];

    const backendResolution = {
      ok: true,
      selectedBackend: "zellij",
      action: "attach",
    };

    const planned = planParallelLaunches({
      launches,
      backendResolution,
      createLaunchId: () => "launch-override",
      now: () => "2025-01-01T00:00:00.000Z",
    });

    assert.equal(planned[0].plan.closePaneOnCompletion, false);
    assert.equal(planned[0].plan.interactive, false);
  });

  it("GIVEN cmux backend WHEN v1 params are provided THEN copilotSessionId is null", async () => {
    const { planParallelLaunches } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/parallel.mjs",
      ["planParallelLaunches"],
    );

    const launches = [
      {
        request: {
          requestedIdentifier: "agent-cmux",
          task: "cmux task",
          interactive: true,
        },
        agentValidation: { ok: true, identifier: "agent-cmux", agentKind: "built-in" },
      },
    ];

    const backendResolution = {
      ok: true,
      selectedBackend: "cmux",
      action: "attach",
    };

    const planned = planParallelLaunches({
      launches,
      backendResolution,
      createLaunchId: () => "launch-cmux",
      now: () => "2025-01-01T00:00:00.000Z",
    });

    assert.equal(planned[0].plan.copilotSessionId, null);
    assert.equal(planned[0].plan.interactive, true);
  });

  it("GIVEN backend discovery WHEN zellij and tmux are both available THEN zellij is preferred", async () => {
    const { SUPPORTED_BACKENDS } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/mux.mjs",
      ["SUPPORTED_BACKENDS"],
    );

    const zellijIndex = SUPPORTED_BACKENDS.indexOf("zellij");
    const tmuxIndex = SUPPORTED_BACKENDS.indexOf("tmux");

    assert.ok(zellijIndex >= 0, "zellij must be in SUPPORTED_BACKENDS");
    assert.ok(tmuxIndex >= 0, "tmux must be in SUPPORTED_BACKENDS");
    assert.ok(
      zellijIndex < tmuxIndex,
      `zellij (index ${zellijIndex}) must come before tmux (index ${tmuxIndex}) in SUPPORTED_BACKENDS`,
    );
  });

  it("GIVEN tool schemas WHEN checking parallel per-launch items THEN v1 params are present", async () => {
    const { PUBLIC_TOOL_PARAMETER_SCHEMAS } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["PUBLIC_TOOL_PARAMETER_SCHEMAS"],
    );

    const parallelSchema = PUBLIC_TOOL_PARAMETER_SCHEMAS.copilot_subagent_parallel;
    const launchItemProps = parallelSchema.properties.launches.items.properties;

    assert.ok(launchItemProps.interactive, "parallel launch items must include interactive");
    assert.ok(launchItemProps.fork, "parallel launch items must include fork");
    assert.ok(
      launchItemProps.closePaneOnCompletion,
      "parallel launch items must include closePaneOnCompletion",
    );
  });

  it("GIVEN tool schemas WHEN checking launch tool THEN closePaneOnCompletion is present", async () => {
    const { PUBLIC_TOOL_PARAMETER_SCHEMAS } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/extension.mjs",
      ["PUBLIC_TOOL_PARAMETER_SCHEMAS"],
    );

    const launchSchema = PUBLIC_TOOL_PARAMETER_SCHEMAS.copilot_subagent_launch;

    assert.ok(
      launchSchema.properties.closePaneOnCompletion,
      "launch schema must include closePaneOnCompletion",
    );
  });
});
