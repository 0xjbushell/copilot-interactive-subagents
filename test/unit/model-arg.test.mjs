import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { importProjectModule } from "../helpers/red-harness.mjs";

const EXT_PATH = "packages/copilot-interactive-subagents/extension/extension.mjs";
const LAUNCH_PATH = "packages/copilot-interactive-subagents/extension/lib/launch.mjs";
const SCHEMAS_PATH = "packages/copilot-interactive-subagents/extension/lib/tool-schemas.mjs";

describe("model arg: createDefaultAgentLaunchCommand", () => {
  it("appends --model <model> after the prompt args when model is provided (default copilot agent)", async () => {
    const { createDefaultAgentLaunchCommand } = await importProjectModule(EXT_PATH, ["createDefaultAgentLaunchCommand"]);
    const cmd = createDefaultAgentLaunchCommand(
      {},
      {},
      { agentIdentifier: "github-copilot", task: "t", copilotSessionId: null, interactive: false, backend: "zellij", model: "gpt-5.2" },
    );
    assert.match(cmd, /"--model",\s*"gpt-5\.2"/);
  });

  it("appends --model <model> for custom agent path too", async () => {
    const { createDefaultAgentLaunchCommand } = await importProjectModule(EXT_PATH, ["createDefaultAgentLaunchCommand"]);
    const cmd = createDefaultAgentLaunchCommand(
      {},
      {},
      { agentIdentifier: "my-agent", task: "t", copilotSessionId: null, interactive: false, backend: "zellij", model: "claude-opus-4.7" },
    );
    assert.match(cmd, /"--model",\s*"claude-opus-4\.7"/);
  });

  it("omits --model entirely when model is not provided", async () => {
    const { createDefaultAgentLaunchCommand } = await importProjectModule(EXT_PATH, ["createDefaultAgentLaunchCommand"]);
    const cmd = createDefaultAgentLaunchCommand(
      {},
      {},
      { agentIdentifier: "github-copilot", task: "t", copilotSessionId: null, interactive: false, backend: "zellij" },
    );
    assert.doesNotMatch(cmd, /--model/);
  });

  it("escapes model strings safely (JSON-stringified inside the JS args literal, then shell-escaped by caller)", async () => {
    const { createDefaultAgentLaunchCommand } = await importProjectModule(EXT_PATH, ["createDefaultAgentLaunchCommand"]);
    const cmd = createDefaultAgentLaunchCommand(
      {},
      {},
      { agentIdentifier: "github-copilot", task: "t", copilotSessionId: null, interactive: false, backend: "zellij", model: 'evil"; rm -rf /' },
    );
    // Whole script body is wrapped in single quotes by shellEscape, so the bash
    // shell never interprets the inner double-quotes. The model value must appear
    // as a JSON-escaped JS string literal — i.e. with the embedded `"` escaped as `\"`.
    assert.ok(cmd.includes('"evil\\"; rm -rf /"'), "model must be JSON-stringified, embedded `\"` escaped as `\\\"`");
    // And the surrounding shell wrapper must be a single-quoted string.
    assert.match(cmd, /node -e '/);
  });
});

describe("model arg: tool schema", () => {
  it("copilot_subagent_launch schema declares optional model:string", async () => {
    const { PUBLIC_TOOL_PARAMETER_SCHEMAS } = await importProjectModule(SCHEMAS_PATH, ["PUBLIC_TOOL_PARAMETER_SCHEMAS"]);
    const launch = PUBLIC_TOOL_PARAMETER_SCHEMAS.copilot_subagent_launch;
    assert.equal(launch.properties.model?.type, "string");
    assert.ok(!(launch.required ?? []).includes("model"), "model must remain optional");
  });

  it("copilot_subagent_parallel per-launch item declares optional model:string", async () => {
    const { PUBLIC_TOOL_PARAMETER_SCHEMAS } = await importProjectModule(SCHEMAS_PATH, ["PUBLIC_TOOL_PARAMETER_SCHEMAS"]);
    const parallel = PUBLIC_TOOL_PARAMETER_SCHEMAS.copilot_subagent_parallel;
    const item = parallel.properties.launches.items;
    assert.equal(item.properties.model?.type, "string");
  });

  it("copilot_subagent_resume schema declares optional model:string (override of manifest model)", async () => {
    const { PUBLIC_TOOL_PARAMETER_SCHEMAS } = await importProjectModule(SCHEMAS_PATH, ["PUBLIC_TOOL_PARAMETER_SCHEMAS"]);
    const resume = PUBLIC_TOOL_PARAMETER_SCHEMAS.copilot_subagent_resume;
    assert.equal(resume.properties.model?.type, "string");
  });
});

describe("model arg: planSingleLaunch threads request.model into plan", () => {
  it("plan.model mirrors request.model when provided", async () => {
    const { planSingleLaunch } = await importProjectModule(LAUNCH_PATH, ["planSingleLaunch"]);
    const plan = planSingleLaunch({
      request: { agentIdentifier: "github-copilot", task: "t", model: "gpt-5.2" },
      agentValidation: { identifier: "github-copilot", agentKind: "default" },
      backendResolution: { selectedBackend: "zellij", action: "send-keys" },
      createLaunchId: () => "lid-1",
      createCopilotSessionId: () => "cs-1",
    });
    assert.equal(plan.model, "gpt-5.2");
  });

  it("plan.model is null when request.model is absent", async () => {
    const { planSingleLaunch } = await importProjectModule(LAUNCH_PATH, ["planSingleLaunch"]);
    const plan = planSingleLaunch({
      request: { agentIdentifier: "github-copilot", task: "t" },
      agentValidation: { identifier: "github-copilot", agentKind: "default" },
      backendResolution: { selectedBackend: "zellij", action: "send-keys" },
      createLaunchId: () => "lid-1",
      createCopilotSessionId: () => "cs-1",
    });
    assert.equal(plan.model ?? null, null);
  });
});
