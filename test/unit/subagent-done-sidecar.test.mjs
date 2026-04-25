import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { importProjectModule } from "../helpers/red-harness.mjs";

const EXT_PATH = "packages/copilot-interactive-subagents/extension/extension.mjs";

async function captureSubagentDoneTool({ childToolServices } = {}) {
  const { registerExtensionSession } = await importProjectModule(EXT_PATH, ["registerExtensionSession"]);
  let registeredTools;
  await registerExtensionSession({
    joinSession: async ({ tools }) => {
      registeredTools = tools;
      return { workspacePath: "/tmp" };
    },
    childToolServices,
  });
  return registeredTools.find((t) => t.name === "subagent_done");
}

describe("D3.1: subagent_done writes done sidecar", () => {
  const SAVE = {
    LAUNCH: process.env.COPILOT_SUBAGENT_LAUNCH_ID,
    SESSION: process.env.COPILOT_SUBAGENT_SESSION_ID,
    STATE: process.env.COPILOT_SUBAGENT_STATE_DIR,
  };

  function setChildEnv() {
    process.env.COPILOT_SUBAGENT_LAUNCH_ID = "L-3-1";
    process.env.COPILOT_SUBAGENT_STATE_DIR = "/tmp/d3-1-state";
    delete process.env.COPILOT_SUBAGENT_SESSION_ID;
  }
  function restore() {
    for (const [k, v] of Object.entries({
      COPILOT_SUBAGENT_LAUNCH_ID: SAVE.LAUNCH,
      COPILOT_SUBAGENT_SESSION_ID: SAVE.SESSION,
      COPILOT_SUBAGENT_STATE_DIR: SAVE.STATE,
    })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }

  it("writes sidecar type=done with summary when summary provided", async () => {
    setChildEnv();
    try {
      const writes = [];
      const services = {
        mkdirSync: () => {},
        writeFileSync: (p, c) => writes.push({ p, c }),
        renameSync: () => {},
        now: () => 1700000000000,
      };
      const tool = await captureSubagentDoneTool({ childToolServices: services });
      const result = tool.handler({ summary: "all green" });
      assert.deepEqual(result, {
        ok: true,
        message: "Session is terminating. Do not call further tools. End your turn.",
      });
      assert.equal(writes.length, 1);
      const payload = JSON.parse(writes[0].c);
      assert.equal(payload.type, "done");
      assert.equal(payload.summary, "all green");
      assert.equal(payload.exitCode, 0);
      assert.equal(payload.launchId, "L-3-1");
    } finally { restore(); }
  });

  it("writes sidecar with summary=null when summary omitted (D2.2 fallback gate)", async () => {
    setChildEnv();
    try {
      const writes = [];
      const services = {
        mkdirSync: () => {},
        writeFileSync: (p, c) => writes.push({ p, c }),
        renameSync: () => {},
        now: () => 1,
      };
      const tool = await captureSubagentDoneTool({ childToolServices: services });
      tool.handler();
      const payload = JSON.parse(writes[0].c);
      assert.equal(payload.summary, null);
    } finally { restore(); }
  });

  it("normalizes empty/whitespace summary to null", async () => {
    setChildEnv();
    try {
      const writes = [];
      const services = {
        mkdirSync: () => {},
        writeFileSync: (p, c) => writes.push({ p, c }),
        renameSync: () => {},
        now: () => 1,
      };
      const tool = await captureSubagentDoneTool({ childToolServices: services });
      tool.handler({ summary: "   " });
      tool.handler({ summary: "" });
      assert.equal(JSON.parse(writes[0].c).summary, null);
      assert.equal(JSON.parse(writes[1].c).summary, null);
    } finally { restore(); }
  });

  it("propagates writeExitSidecar errors (does not swallow)", async () => {
    setChildEnv();
    try {
      const services = {
        mkdirSync: () => {},
        writeFileSync: () => { const e = new Error("ENOSPC"); e.code = "ENOSPC"; throw e; },
        renameSync: () => {},
        now: () => 1,
      };
      const tool = await captureSubagentDoneTool({ childToolServices: services });
      assert.throws(() => tool.handler({ summary: "x" }), /ENOSPC/);
    } finally { restore(); }
  });

  it("handler return shape is exactly the spec string", async () => {
    setChildEnv();
    try {
      const services = { mkdirSync: () => {}, writeFileSync: () => {}, renameSync: () => {}, now: () => 0 };
      const tool = await captureSubagentDoneTool({ childToolServices: services });
      const result = tool.handler({ summary: "ok" });
      assert.deepEqual(Object.keys(result).sort(), ["message", "ok"]);
      assert.equal(result.message, "Session is terminating. Do not call further tools. End your turn.");
      assert.equal(result.ok, true);
    } finally { restore(); }
  });

  it("gates on COPILOT_SUBAGENT_LAUNCH_ID not SESSION_ID (cmux child registration)", async () => {
    const SAVE_L = process.env.COPILOT_SUBAGENT_LAUNCH_ID;
    const SAVE_S = process.env.COPILOT_SUBAGENT_SESSION_ID;
    try {
      delete process.env.COPILOT_SUBAGENT_LAUNCH_ID;
      process.env.COPILOT_SUBAGENT_SESSION_ID = "should-not-trigger";
      const tool = await captureSubagentDoneTool();
      assert.equal(tool, undefined, "subagent_done must not register when only SESSION_ID set");
    } finally {
      if (SAVE_L === undefined) delete process.env.COPILOT_SUBAGENT_LAUNCH_ID; else process.env.COPILOT_SUBAGENT_LAUNCH_ID = SAVE_L;
      if (SAVE_S === undefined) delete process.env.COPILOT_SUBAGENT_SESSION_ID; else process.env.COPILOT_SUBAGENT_SESSION_ID = SAVE_S;
    }
  });
});
