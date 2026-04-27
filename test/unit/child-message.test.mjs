import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { importProjectModule } from "../helpers/red-harness.mjs";

const EXT_PATH = "packages/copilot-interactive-subagents/extension/extension.mjs";

const MAX_MESSAGE_SIZE = 65536; // 64 KiB

function createTmpStateDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "child-message-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withChildEnv(t, launchId, stateDir) {
  const saved = {
    COPILOT_SUBAGENT_LAUNCH_ID: process.env.COPILOT_SUBAGENT_LAUNCH_ID,
    COPILOT_SUBAGENT_STATE_DIR: process.env.COPILOT_SUBAGENT_STATE_DIR,
    COPILOT_SUBAGENT_SESSION_ID: process.env.COPILOT_SUBAGENT_SESSION_ID,
  };
  process.env.COPILOT_SUBAGENT_LAUNCH_ID = launchId;
  process.env.COPILOT_SUBAGENT_STATE_DIR = stateDir;
  delete process.env.COPILOT_SUBAGENT_SESSION_ID;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

async function getMessageTool(t, launchId, stateDir) {
  withChildEnv(t, launchId, stateDir);
  const { registerExtensionSession } = await importProjectModule(EXT_PATH, ["registerExtensionSession"]);
  let registered;
  await registerExtensionSession({
    joinSession: async ({ tools }) => { registered = tools; return { workspacePath: "/tmp" }; },
  });
  const tool = registered.find((tool) => tool.name === "copilot_subagent_message");
  return { tool, tools: registered };
}

describe("copilot_subagent_message (child tool)", () => {
  it("appends a record to pings.jsonl and returns {ok:true, writtenAt}", async (t) => {
    const stateDir = createTmpStateDir(t);
    const launchId = "lch_msg-001";
    const { tool } = await getMessageTool(t, launchId, stateDir);
    assert.ok(tool, "copilot_subagent_message should be registered in child env");

    const result = await tool.handler({ message: "hello from child" });

    assert.equal(result.ok, true);
    assert.ok(result.writtenAt);

    const filePath = path.join(stateDir, "pings", `${launchId}.jsonl`);
    assert.ok(fs.existsSync(filePath));
    const record = JSON.parse(fs.readFileSync(filePath, "utf8").trim());
    assert.equal(record.message, "hello from child");
    assert.equal(record.type, "message");
    assert.equal(record.version, 1);
  });

  it("rejects empty message with INVALID_MESSAGE before any I/O", async (t) => {
    const stateDir = createTmpStateDir(t);
    const { tool } = await getMessageTool(t, "lch_empty", stateDir);

    const result = await tool.handler({ message: "" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "INVALID_MESSAGE");

    assert.ok(!fs.existsSync(path.join(stateDir, "pings")));
  });

  it("rejects whitespace-only message with INVALID_MESSAGE", async (t) => {
    const stateDir = createTmpStateDir(t);
    const { tool } = await getMessageTool(t, "lch_ws", stateDir);

    const result = await tool.handler({ message: "   \n\t  " });
    assert.equal(result.ok, false);
    assert.equal(result.error, "INVALID_MESSAGE");
  });

  it("rejects message > 64 KiB with INVALID_MESSAGE", async (t) => {
    const stateDir = createTmpStateDir(t);
    const { tool } = await getMessageTool(t, "lch_big", stateDir);

    const result = await tool.handler({ message: "x".repeat(MAX_MESSAGE_SIZE + 1) });
    assert.equal(result.ok, false);
    assert.equal(result.error, "INVALID_MESSAGE");
  });

  it("accepts message of exactly 64 KiB", async (t) => {
    const stateDir = createTmpStateDir(t);
    const { tool } = await getMessageTool(t, "lch_boundary", stateDir);

    const result = await tool.handler({ message: "x".repeat(MAX_MESSAGE_SIZE) });
    assert.equal(result.ok, true);
  });

  it("preserves embedded newlines losslessly", async (t) => {
    const stateDir = createTmpStateDir(t);
    const launchId = "lch_newlines";
    const { tool } = await getMessageTool(t, launchId, stateDir);

    const messageWithNewlines = "line1\nline2\nline3";
    await tool.handler({ message: messageWithNewlines });

    const filePath = path.join(stateDir, "pings", `${launchId}.jsonl`);
    const record = JSON.parse(fs.readFileSync(filePath, "utf8").trim());
    assert.equal(record.message, messageWithNewlines);
  });

  it("returns SIDECAR_WRITE_FAILED on filesystem error", async (t) => {
    const stateDir = "/nonexistent/path/that/cannot/be/created";
    const { tool } = await getMessageTool(t, "lch_fail", stateDir);

    const result = await tool.handler({ message: "will fail" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "SIDECAR_WRITE_FAILED");
    assert.ok(result.message, "should include underlying error message");
  });

  it("is NOT registered in parent env (no LAUNCH_ID)", async (t) => {
    const saved = process.env.COPILOT_SUBAGENT_LAUNCH_ID;
    delete process.env.COPILOT_SUBAGENT_LAUNCH_ID;
    t.after(() => {
      if (saved === undefined) delete process.env.COPILOT_SUBAGENT_LAUNCH_ID;
      else process.env.COPILOT_SUBAGENT_LAUNCH_ID = saved;
    });

    const { registerExtensionSession } = await importProjectModule(EXT_PATH, ["registerExtensionSession"]);
    let registered;
    await registerExtensionSession({
      joinSession: async ({ tools }) => { registered = tools; return { workspacePath: "/tmp" }; },
    });
    const names = registered.map((tool) => tool.name);
    assert.ok(!names.includes("copilot_subagent_message"), "parent should not see copilot_subagent_message");
  });
});
