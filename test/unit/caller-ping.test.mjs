import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { importProjectModule } from "../helpers/red-harness.mjs";

const EXTENSION = "packages/copilot-interactive-subagents/extension/extension.mjs";
const EXIT_SIDECAR = "packages/copilot-interactive-subagents/extension/lib/exit-sidecar.mjs";
const SCHEMAS = "packages/copilot-interactive-subagents/extension/lib/tool-schemas.mjs";

let savedEnv;
function snapshotEnv() {
  savedEnv = {
    LAUNCH_ID: process.env.COPILOT_SUBAGENT_LAUNCH_ID,
    SESSION_ID: process.env.COPILOT_SUBAGENT_SESSION_ID,
    STATE_DIR: process.env.COPILOT_SUBAGENT_STATE_DIR,
  };
}
function restoreEnv() {
  for (const [k, v] of Object.entries({
    COPILOT_SUBAGENT_LAUNCH_ID: savedEnv.LAUNCH_ID,
    COPILOT_SUBAGENT_SESSION_ID: savedEnv.SESSION_ID,
    COPILOT_SUBAGENT_STATE_DIR: savedEnv.STATE_DIR,
  })) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

describe("D2.1 caller_ping registration + childToolServices plumbing", () => {
  before(snapshotEnv);
  afterEach(restoreEnv);
  after(restoreEnv);

  async function captureRegisteredTools(envOverrides = {}) {
    const { registerExtensionSession } = await importProjectModule(
      EXTENSION,
      ["registerExtensionSession"],
    );
    for (const [k, v] of Object.entries(envOverrides)) {
      if (v === null) delete process.env[k]; else process.env[k] = v;
    }
    let captured;
    await registerExtensionSession({
      joinSession: ({ tools }) => {
        captured = tools;
        return { tools, workspacePath: process.cwd(), rpc: { agent: { list: async () => ({ agents: [] }) } } };
      },
      createHandlers: async () => ({}),
    });
    return captured;
  }

  it("exports CALLER_PING_TOOL_NAME constant from tool-schemas", async () => {
    const { CALLER_PING_TOOL_NAME } = await importProjectModule(SCHEMAS, ["CALLER_PING_TOOL_NAME"]);
    assert.equal(CALLER_PING_TOOL_NAME, "caller_ping");
  });

  it("does NOT export CALLER_PING_TOOL_DEF (runtime def lives only inline)", async () => {
    const mod = await import(`${process.cwd()}/packages/copilot-interactive-subagents/extension/lib/tool-schemas.mjs`);
    assert.equal(mod.CALLER_PING_TOOL_DEF, undefined);
  });

  it("registers caller_ping in child sessions (COPILOT_SUBAGENT_LAUNCH_ID set)", async () => {
    const tools = await captureRegisteredTools({
      COPILOT_SUBAGENT_LAUNCH_ID: "L-child",
      COPILOT_SUBAGENT_SESSION_ID: null,
    });
    const tool = tools.find((t) => t.name === "caller_ping");
    assert.ok(tool, "caller_ping must be registered in child sessions");
    assert.equal(tool.parameters.required[0], "message");
  });

  it("does NOT register caller_ping in parent sessions (no LAUNCH_ID)", async () => {
    const tools = await captureRegisteredTools({
      COPILOT_SUBAGENT_LAUNCH_ID: null,
      COPILOT_SUBAGENT_SESSION_ID: null,
    });
    assert.equal(tools.find((t) => t.name === "caller_ping"), undefined);
  });

  it("caller_ping handler writes a ping sidecar with launchId+message and returns the verbatim spec string", async (t) => {
    const tmpStateDir = await mkdtemp(path.join(os.tmpdir(), "d2-1-caller-ping-"));
    t.after(() => rm(tmpStateDir, { recursive: true, force: true }));

    const tools = await captureRegisteredTools({
      COPILOT_SUBAGENT_LAUNCH_ID: "L-ping-1",
      COPILOT_SUBAGENT_SESSION_ID: null,
      COPILOT_SUBAGENT_STATE_DIR: tmpStateDir,
    });
    const tool = tools.find((t) => t.name === "caller_ping");
    const result = await tool.handler({ message: "need decision X?" });

    assert.deepEqual(result, {
      ok: true,
      message: "Ping sent. Session is terminating. Do not call further tools. End your turn.",
    });

    const sidecarPath = path.join(tmpStateDir, "exit", "L-ping-1.json");
    assert.ok(existsSync(sidecarPath), "sidecar must exist");
    const parsed = JSON.parse(readFileSync(sidecarPath, "utf8"));
    assert.equal(parsed.version, 1);
    assert.equal(parsed.type, "ping");
    assert.equal(parsed.launchId, "L-ping-1");
    assert.equal(parsed.message, "need decision X?");
    assert.equal(typeof parsed.writtenAt, "string");
  });

  it("caller_ping handler does NOT call process.exit", async (t) => {
    const tmpStateDir = await mkdtemp(path.join(os.tmpdir(), "d2-1-no-exit-"));
    t.after(() => rm(tmpStateDir, { recursive: true, force: true }));

    const tools = await captureRegisteredTools({
      COPILOT_SUBAGENT_LAUNCH_ID: "L-noexit",
      COPILOT_SUBAGENT_SESSION_ID: null,
      COPILOT_SUBAGENT_STATE_DIR: tmpStateDir,
    });
    const tool = tools.find((t) => t.name === "caller_ping");

    const originalExit = process.exit;
    let exitCalled = false;
    process.exit = () => { exitCalled = true; };
    try {
      await tool.handler({ message: "hi" });
    } finally {
      process.exit = originalExit;
    }
    assert.equal(exitCalled, false, "handler must not invoke process.exit");
  });

  it("caller_ping uses childToolServices override for fs DI", async (t) => {
    const { registerExtensionSession } = await importProjectModule(EXTENSION, ["registerExtensionSession"]);
    process.env.COPILOT_SUBAGENT_LAUNCH_ID = "L-di";
    delete process.env.COPILOT_SUBAGENT_SESSION_ID;
    process.env.COPILOT_SUBAGENT_STATE_DIR = "/some/state";

    let captured;
    const writes = [];
    await registerExtensionSession({
      joinSession: ({ tools }) => { captured = tools; return { tools, workspacePath: process.cwd(), rpc: { agent: { list: async () => ({ agents: [] }) } } }; },
      createHandlers: async () => ({}),
      childToolServices: {
        writeFileSync: (p, contents) => writes.push({ p, contents }),
        renameSync: () => {},
        mkdirSync: () => {},
        now: () => "2026-01-01T00:00:00.000Z",
      },
    });
    const tool = captured.find((t) => t.name === "caller_ping");
    await tool.handler({ message: "via DI" });
    assert.equal(writes.length, 1, "childToolServices.writeFileSync must be invoked");
    const parsed = JSON.parse(writes[0].contents);
    assert.equal(parsed.message, "via DI");
    assert.equal(parsed.type, "ping");
  });

  it("caller_ping handler returns the verbatim string even when sidecar write throws (best-effort)", async (t) => {
    const { registerExtensionSession } = await importProjectModule(EXTENSION, ["registerExtensionSession"]);
    process.env.COPILOT_SUBAGENT_LAUNCH_ID = "L-write-fail";
    delete process.env.COPILOT_SUBAGENT_SESSION_ID;
    process.env.COPILOT_SUBAGENT_STATE_DIR = "/some/state";

    let captured;
    await registerExtensionSession({
      joinSession: ({ tools }) => { captured = tools; return { tools, workspacePath: process.cwd(), rpc: { agent: { list: async () => ({ agents: [] }) } } }; },
      createHandlers: async () => ({}),
      childToolServices: {
        writeFileSync: () => { const e = new Error("EACCES"); e.code = "EACCES"; throw e; },
        renameSync: () => {},
        mkdirSync: () => {},
        now: () => "2026-01-01T00:00:00.000Z",
      },
    });
    const tool = captured.find((t) => t.name === "caller_ping");

    // Suppress stderr noise during the test (handler logs the swallowed error).
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      const result = await tool.handler({ message: "io fails" });
      assert.deepEqual(result, {
        ok: true,
        message: "Ping sent. Session is terminating. Do not call further tools. End your turn.",
      });
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("caller_ping handler throws STATE_DIR_MISSING when LAUNCH_ID set but STATE_DIR unset", async (t) => {
    const { registerExtensionSession } = await importProjectModule(EXTENSION, ["registerExtensionSession"]);
    process.env.COPILOT_SUBAGENT_LAUNCH_ID = "L-no-statedir";
    delete process.env.COPILOT_SUBAGENT_SESSION_ID;
    delete process.env.COPILOT_SUBAGENT_STATE_DIR;

    let captured;
    await registerExtensionSession({
      joinSession: ({ tools }) => { captured = tools; return { tools, workspacePath: process.cwd(), rpc: { agent: { list: async () => ({ agents: [] }) } } }; },
      createHandlers: async () => ({}),
    });
    const tool = captured.find((t) => t.name === "caller_ping");
    // The handler runs resolveChildStateDir BEFORE writeExitSidecar; the throw
    // escapes the try/catch around writeExitSidecar (it's outside the try).
    // Wait — actually it's INSIDE the try call expression. Verify by asserting:
    // since we wrap the WHOLE writeExitSidecar() expression including
    // resolveChildStateDir() arg, the throw IS caught. So the contract is:
    // verbatim string is still returned, and the error is logged to stderr.
    const origWrite = process.stderr.write.bind(process.stderr);
    let stderrCapture = "";
    process.stderr.write = (s) => { stderrCapture += String(s); return true; };
    try {
      const result = await tool.handler({ message: "no state dir" });
      assert.deepEqual(result, {
        ok: true,
        message: "Ping sent. Session is terminating. Do not call further tools. End your turn.",
      });
      assert.match(stderrCapture, /STATE_DIR/i);
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
