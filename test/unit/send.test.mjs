import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { importProjectModule } from "../helpers/red-harness.mjs";

const { sendMessage } = await importProjectModule(
  "packages/copilot-interactive-subagents/extension/lib/send.mjs",
  ["sendMessage"],
);

function makeServices(overrides = {}) {
  return {
    readLaunchRecord: async () => ({ backend: "tmux", paneId: "%42" }),
    probeBackendAvailable: async () => true,
    probeSessionLiveness: () => true,
    runBackendSendKeys: async () => {},
    ...overrides,
  };
}

describe("sendMessage", () => {
  it("happy path: delivers a message and returns ok:true", async () => {
    let captured;
    const result = await sendMessage({
      launchId: "launch-1",
      message: "hello child",
      services: makeServices({
        runBackendSendKeys: async (args) => { captured = args; },
      }),
    });
    assert.deepEqual(result, { ok: true, delivered: true, paneId: "%42", reply: null });
    assert.equal(captured.backend, "tmux");
    assert.equal(captured.paneId, "%42");
    assert.ok(captured.payload.includes("hello child"));
    assert.ok(captured.payload.startsWith("\x1b[200~"));
    assert.ok(captured.payload.endsWith("\x1b[201~"));
  });

  it("wraps multiline messages in bracketed paste", async () => {
    let captured;
    const msg = "line1\nline2\nline3";
    await sendMessage({
      launchId: "launch-1",
      message: msg,
      services: makeServices({
        runBackendSendKeys: async (args) => { captured = args; },
      }),
    });
    assert.ok(captured.payload.includes(msg));
    assert.ok(captured.payload.startsWith("\x1b[200~"));
    assert.ok(captured.payload.endsWith("\x1b[201~"));
  });

  it("returns PANE_DEAD when session is not alive", async () => {
    const result = await sendMessage({
      launchId: "launch-1",
      message: "hello",
      services: makeServices({ probeSessionLiveness: () => false }),
    });
    assert.deepEqual(result, { ok: false, error: "PANE_DEAD" });
  });

  it("returns INVALID_MESSAGE for empty string", async () => {
    const result = await sendMessage({
      launchId: "launch-1",
      message: "",
      services: makeServices(),
    });
    assert.deepEqual(result, { ok: false, error: "INVALID_MESSAGE" });
  });

  it("returns INVALID_MESSAGE for whitespace-only string", async () => {
    const result = await sendMessage({
      launchId: "launch-1",
      message: "   \n\t  ",
      services: makeServices(),
    });
    assert.deepEqual(result, { ok: false, error: "INVALID_MESSAGE" });
  });

  it("returns INVALID_MESSAGE for oversized message (>64 KiB)", async () => {
    const result = await sendMessage({
      launchId: "launch-1",
      message: "x".repeat(65537),
      services: makeServices(),
    });
    assert.deepEqual(result, { ok: false, error: "INVALID_MESSAGE" });
  });

  it("returns INVALID_MESSAGE for non-string message", async () => {
    const result = await sendMessage({
      launchId: "launch-1",
      message: 42,
      services: makeServices(),
    });
    assert.deepEqual(result, { ok: false, error: "INVALID_MESSAGE" });
  });

  it("returns LAUNCH_NOT_FOUND when readLaunchRecord throws", async () => {
    const err = new Error("not found");
    err.code = "ENOENT";
    const result = await sendMessage({
      launchId: "nonexistent",
      message: "hello",
      services: makeServices({
        readLaunchRecord: async () => { throw err; },
      }),
    });
    assert.deepEqual(result, { ok: false, error: "LAUNCH_NOT_FOUND" });
  });

  it("returns BACKEND_UNAVAILABLE when backend probe fails", async () => {
    const result = await sendMessage({
      launchId: "launch-1",
      message: "hello",
      services: makeServices({ probeBackendAvailable: async () => false }),
    });
    assert.deepEqual(result, { ok: false, error: "BACKEND_UNAVAILABLE" });
  });

  it("checks INVALID_MESSAGE before LAUNCH_NOT_FOUND", async () => {
    const err = new Error("not found");
    err.code = "ENOENT";
    const result = await sendMessage({
      launchId: "nonexistent",
      message: "",
      services: makeServices({
        readLaunchRecord: async () => { throw err; },
      }),
    });
    assert.equal(result.error, "INVALID_MESSAGE");
  });

  it("checks LAUNCH_NOT_FOUND before BACKEND_UNAVAILABLE", async () => {
    const err = new Error("not found");
    err.code = "ENOENT";
    const result = await sendMessage({
      launchId: "nonexistent",
      message: "hello",
      services: makeServices({
        readLaunchRecord: async () => { throw err; },
        probeBackendAvailable: async () => false,
      }),
    });
    assert.equal(result.error, "LAUNCH_NOT_FOUND");
  });

  it("checks BACKEND_UNAVAILABLE before PANE_DEAD", async () => {
    const result = await sendMessage({
      launchId: "launch-1",
      message: "hello",
      services: makeServices({
        probeBackendAvailable: async () => false,
        probeSessionLiveness: () => false,
      }),
    });
    assert.equal(result.error, "BACKEND_UNAVAILABLE");
  });

  it("forwards backend and paneId from manifest to runBackendSendKeys", async () => {
    let captured;
    await sendMessage({
      launchId: "launch-1",
      message: "hello",
      services: makeServices({
        readLaunchRecord: async () => ({ backend: "zellij", paneId: "zj-99" }),
        runBackendSendKeys: async (args) => { captured = args; },
      }),
    });
    assert.equal(captured.backend, "zellij");
    assert.equal(captured.paneId, "zj-99");
  });

  it("accepts boundary message at exactly 64 KiB", async () => {
    const result = await sendMessage({
      launchId: "launch-1",
      message: "x".repeat(65536),
      services: makeServices(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.delivered, true);
  });

  it("propagates non-ENOENT readLaunchRecord errors", async () => {
    const err = new Error("MANIFEST_VERSION_UNSUPPORTED");
    err.code = "MANIFEST_VERSION_UNSUPPORTED";
    await assert.rejects(
      () => sendMessage({
        launchId: "launch-1",
        message: "hello",
        services: makeServices({
          readLaunchRecord: async () => { throw err; },
        }),
      }),
      (thrown) => thrown.code === "MANIFEST_VERSION_UNSUPPORTED",
    );
  });
});
