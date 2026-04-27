import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { importProjectModule } from "../helpers/red-harness.mjs";

const EXT_PATH = "packages/copilot-interactive-subagents/extension/extension.mjs";

async function captureRegisteredTools(env) {
  const SAVE = {
    LAUNCH: process.env.COPILOT_SUBAGENT_LAUNCH_ID,
    SESSION: process.env.COPILOT_SUBAGENT_SESSION_ID,
    STATE: process.env.COPILOT_SUBAGENT_STATE_DIR,
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
  try {
    const { registerExtensionSession } = await importProjectModule(EXT_PATH, ["registerExtensionSession"]);
    let registered;
    await registerExtensionSession({
      joinSession: async ({ tools }) => { registered = tools; return { workspacePath: "/tmp" }; },
    });
    return registered;
  } finally {
    for (const [k, v] of Object.entries({
      COPILOT_SUBAGENT_LAUNCH_ID: SAVE.LAUNCH,
      COPILOT_SUBAGENT_SESSION_ID: SAVE.SESSION,
      COPILOT_SUBAGENT_STATE_DIR: SAVE.STATE,
    })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

describe("D4.1: PUBLIC_SPAWNING_TOOL_NAMES filter", () => {
  it("exports the exact 14-name set from tool-schemas.mjs", async () => {
    const { PUBLIC_SPAWNING_TOOL_NAMES } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/lib/tool-schemas.mjs",
      ["PUBLIC_SPAWNING_TOOL_NAMES"],
    );
    const expected = [
      "copilot_subagent_launch", "copilot_subagent_parallel",
      "copilot_subagent_resume", "copilot_subagent_set_title",
      "copilot_subagent_list_agents", "copilot_subagent_read_messages",
      "copilot_subagent_send",
      "copilotSubagentLaunch", "copilotSubagentParallel",
      "copilotSubagentResume", "copilotSubagentSetTitle",
      "copilotSubagentListAgents", "copilotSubagentReadMessages",
      "copilotSubagentSend",
    ];
    assert.equal(PUBLIC_SPAWNING_TOOL_NAMES.size, 14);
    for (const name of expected) {
      assert.ok(PUBLIC_SPAWNING_TOOL_NAMES.has(name), `expected ${name} in set`);
    }
  });

  it("PARENT (no LAUNCH_ID): all 14 spawning tools registered (snake + camelCase)", async () => {
    const tools = await captureRegisteredTools({
      COPILOT_SUBAGENT_LAUNCH_ID: null,
      COPILOT_SUBAGENT_SESSION_ID: null,
    });
    const names = new Set(tools.map((t) => t.name));
    const expected = [
      "copilot_subagent_launch", "copilot_subagent_parallel",
      "copilot_subagent_resume", "copilot_subagent_set_title",
      "copilot_subagent_list_agents", "copilot_subagent_read_messages",
      "copilot_subagent_send",
      "copilotSubagentLaunch", "copilotSubagentParallel",
      "copilotSubagentResume", "copilotSubagentSetTitle",
      "copilotSubagentListAgents", "copilotSubagentReadMessages",
      "copilotSubagentSend",
    ];
    for (const n of expected) {
      assert.ok(names.has(n), `parent should expose ${n}, got: ${[...names].join(", ")}`);
    }
  });

  it("CHILD (LAUNCH_ID set): NONE of the 10 spawning tools registered", async () => {
    const { PUBLIC_SPAWNING_TOOL_NAMES } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/lib/tool-schemas.mjs",
      ["PUBLIC_SPAWNING_TOOL_NAMES"],
    );
    const tools = await captureRegisteredTools({
      COPILOT_SUBAGENT_LAUNCH_ID: "child-launch-id",
      COPILOT_SUBAGENT_STATE_DIR: "/tmp/state",
      COPILOT_SUBAGENT_SESSION_ID: null,
    });
    for (const tool of tools) {
      assert.ok(
        !PUBLIC_SPAWNING_TOOL_NAMES.has(tool.name),
        `child must NOT expose ${tool.name}`,
      );
    }
  });

  it("CHILD: gating uses LAUNCH_ID even when SESSION_ID is null (cmux backend)", async () => {
    const tools = await captureRegisteredTools({
      COPILOT_SUBAGENT_LAUNCH_ID: "cmux-launch",
      COPILOT_SUBAGENT_STATE_DIR: "/tmp/state",
      COPILOT_SUBAGENT_SESSION_ID: null,
    });
    const names = tools.map((t) => t.name);
    assert.ok(!names.includes("copilot_subagent_launch"));
    assert.ok(!names.includes("copilotSubagentLaunch"));
  });

  it("CHILD: child-only tools (caller_ping, subagent_done, copilot_subagent_message) ARE present", async () => {
    const tools = await captureRegisteredTools({
      COPILOT_SUBAGENT_LAUNCH_ID: "child-id",
      COPILOT_SUBAGENT_STATE_DIR: "/tmp/state",
      COPILOT_SUBAGENT_SESSION_ID: null,
    });
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("caller_ping"), "caller_ping must remain registered for children");
    assert.ok(names.includes("subagent_done"), "subagent_done must remain registered for children");
    assert.ok(names.includes("copilot_subagent_message"), "copilot_subagent_message must be registered for children");
  });

  it("PARENT: copilot_subagent_message is NOT exposed", async () => {
    const tools = await captureRegisteredTools({
      COPILOT_SUBAGENT_LAUNCH_ID: null,
      COPILOT_SUBAGENT_SESSION_ID: null,
    });
    const names = tools.map((t) => t.name);
    assert.ok(!names.includes("copilot_subagent_message"), "parent must NOT see copilot_subagent_message");
  });

  it("CHILD: copilot_subagent_read_messages is NOT exposed", async () => {
    const tools = await captureRegisteredTools({
      COPILOT_SUBAGENT_LAUNCH_ID: "child-id",
      COPILOT_SUBAGENT_STATE_DIR: "/mock/state",
      COPILOT_SUBAGENT_SESSION_ID: null,
    });
    const names = tools.map((t) => t.name);
    assert.ok(!names.includes("copilot_subagent_read_messages"), "child must NOT see copilot_subagent_read_messages");
    assert.ok(!names.includes("copilotSubagentReadMessages"), "child must NOT see copilotSubagentReadMessages");
  });

  it("CHILD: copilot_subagent_send is NOT exposed", async () => {
    const tools = await captureRegisteredTools({
      COPILOT_SUBAGENT_LAUNCH_ID: "child-id",
      COPILOT_SUBAGENT_STATE_DIR: "/mock/state",
      COPILOT_SUBAGENT_SESSION_ID: null,
    });
    const names = tools.map((t) => t.name);
    assert.ok(!names.includes("copilot_subagent_send"), "child must NOT see copilot_subagent_send");
    assert.ok(!names.includes("copilotSubagentSend"), "child must NOT see copilotSubagentSend");
  });

  it("PARENT: copilot_subagent_send IS exposed", async () => {
    const tools = await captureRegisteredTools({
      COPILOT_SUBAGENT_LAUNCH_ID: null,
      COPILOT_SUBAGENT_SESSION_ID: null,
    });
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("copilot_subagent_send"), "parent must expose copilot_subagent_send");
    assert.ok(names.includes("copilotSubagentSend"), "parent must expose copilotSubagentSend");
  });
});
