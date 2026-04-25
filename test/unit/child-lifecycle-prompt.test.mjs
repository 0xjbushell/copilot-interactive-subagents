import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { importProjectModule } from "../helpers/red-harness.mjs";

const EXT_PATH = "packages/copilot-interactive-subagents/extension/extension.mjs";

async function loadRegister() {
  const { registerExtensionSession } = await importProjectModule(EXT_PATH, ["registerExtensionSession"]);
  return registerExtensionSession;
}

function withChildEnv(launchId, fn) {
  const original = process.env.COPILOT_SUBAGENT_LAUNCH_ID;
  process.env.COPILOT_SUBAGENT_LAUNCH_ID = launchId;
  return Promise.resolve(fn()).finally(() => {
    if (original === undefined) delete process.env.COPILOT_SUBAGENT_LAUNCH_ID;
    else process.env.COPILOT_SUBAGENT_LAUNCH_ID = original;
  });
}

function withoutChildEnv(fn) {
  const original = process.env.COPILOT_SUBAGENT_LAUNCH_ID;
  delete process.env.COPILOT_SUBAGENT_LAUNCH_ID;
  return Promise.resolve(fn()).finally(() => {
    if (original !== undefined) process.env.COPILOT_SUBAGENT_LAUNCH_ID = original;
  });
}

describe("Child-lifecycle system message (TIX-000059)", () => {
  it("GIVEN COPILOT_SUBAGENT_LAUNCH_ID set WHEN session registers THEN systemMessage.append is passed with subagent lifecycle content", async () => {
    const register = await loadRegister();
    let captured;
    const mockJoinSession = async (config) => {
      captured = config;
      return { workspacePath: "/tmp" };
    };

    await withChildEnv("test-launch", () => register({ joinSession: mockJoinSession }));

    assert.ok(captured.systemMessage, "systemMessage should be passed");
    assert.equal(captured.systemMessage.mode, "append", "must use append mode (preserves SDK guardrails)");
    assert.ok(typeof captured.systemMessage.content === "string" && captured.systemMessage.content.length > 0,
      "content must be non-empty string");
    assert.ok(captured.systemMessage.content.includes("subagent_done"),
      "content must mention subagent_done");
    assert.ok(captured.systemMessage.content.includes("caller_ping"),
      "content must mention caller_ping");
    assert.ok(/resume|reopen/i.test(captured.systemMessage.content),
      "content must explain parent can resume so premature done is recoverable");
    assert.ok(/pane|exit|close/i.test(captured.systemMessage.content),
      "content must mention pane/exit lifecycle");
  });

  it("GIVEN COPILOT_SUBAGENT_LAUNCH_ID NOT set WHEN session registers THEN systemMessage is NOT passed", async () => {
    const register = await loadRegister();
    let captured;
    const mockJoinSession = async (config) => {
      captured = config;
      return { workspacePath: "/tmp" };
    };

    await withoutChildEnv(() => register({ joinSession: mockJoinSession }));

    assert.equal(captured.systemMessage, undefined,
      "parent sessions must not receive a child-lifecycle systemMessage");
  });
});
