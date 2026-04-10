import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importProjectModule } from "../helpers/red-harness.mjs";

describe("Ephemeral pane lifecycle", () => {
  const createWorkspace = (t) => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-ephemeral-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  describe("closePane", () => {
    it("GIVEN tmux backend WHEN closePane called THEN executes kill-pane", async () => {
      const { closePane } = await importProjectModule(
        ".github/extensions/copilot-interactive-subagents/lib/close-pane.mjs",
        ["closePane"],
      );

      const calls = [];
      const result = closePane({
        backend: "tmux",
        paneId: "%5",
        services: {
          spawnSync: (cmd, args) => {
            calls.push({ cmd, args });
            return { status: 0 };
          },
        },
      });

      assert.equal(result.ok, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cmd, "tmux");
      assert.deepEqual(calls[0].args, ["kill-pane", "-t", "%5"]);
    });

    it("GIVEN zellij backend WHEN closePane called THEN executes close-pane with env", async () => {
      const { closePane } = await importProjectModule(
        ".github/extensions/copilot-interactive-subagents/lib/close-pane.mjs",
        ["closePane"],
      );

      let capturedEnv;
      const result = closePane({
        backend: "zellij",
        paneId: "pane:42",
        services: {
          spawnSync: (cmd, args, opts) => {
            capturedEnv = opts?.env;
            return { status: 0 };
          },
        },
      });

      assert.equal(result.ok, true);
      assert.equal(capturedEnv.ZELLIJ_PANE_ID, "pane:42");
    });

    it("GIVEN pane already dead WHEN closePane called THEN returns ok with alreadyClosed", async () => {
      const { closePane } = await importProjectModule(
        ".github/extensions/copilot-interactive-subagents/lib/close-pane.mjs",
        ["closePane"],
      );

      const result = closePane({
        backend: "tmux",
        paneId: "%99",
        services: {
          spawnSync: () => ({ status: 1, stderr: Buffer.from("pane not found") }),
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.alreadyClosed, true);
    });

    it("GIVEN unknown backend WHEN closePane called THEN throws structured error", async () => {
      const { closePane } = await importProjectModule(
        ".github/extensions/copilot-interactive-subagents/lib/close-pane.mjs",
        ["closePane"],
      );

      assert.throws(
        () => closePane({ backend: "screen", paneId: "1" }),
        { code: "CLOSE_PANE_UNSUPPORTED_BACKEND" },
      );
    });
  });

  describe("extractSessionSummary", () => {
    it("GIVEN events.jsonl with assistant.message WHEN extracted THEN returns last content", async (t) => {
      const { extractSessionSummary } = await importProjectModule(
        ".github/extensions/copilot-interactive-subagents/lib/summary.mjs",
        ["extractSessionSummary"],
      );

      const copilotHome = createWorkspace(t);
      const sessionId = "test-session-001";
      const sessionDir = join(copilotHome, "session-state", sessionId);
      mkdirSync(sessionDir, { recursive: true });

      const events = [
        { type: "user.message", data: { content: "hello" } },
        { type: "assistant.message", data: { content: "First response" } },
        { type: "assistant.message", data: { content: "Final answer" } },
      ];
      writeFileSync(
        join(sessionDir, "events.jsonl"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      const result = extractSessionSummary({
        copilotSessionId: sessionId,
        copilotHome: join(copilotHome, "session-state", ".."),
      });

      assert.equal(result.summary, "Final answer");
      assert.equal(result.source, "events.jsonl");
      assert.equal(result.lastEventIndex, 3);
    });

    it("GIVEN empty events.jsonl WHEN extracted THEN returns null summary", async (t) => {
      const { extractSessionSummary } = await importProjectModule(
        ".github/extensions/copilot-interactive-subagents/lib/summary.mjs",
        ["extractSessionSummary"],
      );

      const copilotHome = createWorkspace(t);
      const sessionId = "test-session-empty";
      const sessionDir = join(copilotHome, "session-state", sessionId);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, "events.jsonl"), "");

      const result = extractSessionSummary({
        copilotSessionId: sessionId,
        copilotHome: join(copilotHome, "session-state", ".."),
      });

      assert.equal(result.summary, null);
      assert.equal(result.lastEventIndex, 0);
    });

    it("GIVEN missing session dir WHEN extracted THEN returns null gracefully", async () => {
      const { extractSessionSummary } = await importProjectModule(
        ".github/extensions/copilot-interactive-subagents/lib/summary.mjs",
        ["extractSessionSummary"],
      );

      const result = extractSessionSummary({
        copilotSessionId: "nonexistent-session",
        copilotHome: "/tmp/does-not-exist-copilot",
      });

      assert.equal(result.summary, null);
      assert.equal(result.source, "fallback");
      assert.equal(result.lastEventIndex, 0);
    });

    it("GIVEN sinceEventIndex WHEN delta mode THEN only considers events after index", async (t) => {
      const { extractSessionSummary } = await importProjectModule(
        ".github/extensions/copilot-interactive-subagents/lib/summary.mjs",
        ["extractSessionSummary"],
      );

      const copilotHome = createWorkspace(t);
      const sessionId = "test-session-delta";
      const sessionDir = join(copilotHome, "session-state", sessionId);
      mkdirSync(sessionDir, { recursive: true });

      const events = [
        { type: "assistant.message", data: { content: "Old message" } },
        { type: "assistant.message", data: { content: "Old message 2" } },
        { type: "user.message", data: { content: "new input" } },
        { type: "assistant.message", data: { content: "New response" } },
      ];
      writeFileSync(
        join(sessionDir, "events.jsonl"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      const result = extractSessionSummary({
        copilotSessionId: sessionId,
        sinceEventIndex: 2,
        copilotHome: join(copilotHome, "session-state", ".."),
      });

      assert.equal(result.summary, "New response");
      assert.equal(result.lastEventIndex, 4);
    });

    it("GIVEN sinceEventIndex with no new assistant.message WHEN delta mode THEN returns null", async (t) => {
      const { extractSessionSummary } = await importProjectModule(
        ".github/extensions/copilot-interactive-subagents/lib/summary.mjs",
        ["extractSessionSummary"],
      );

      const copilotHome = createWorkspace(t);
      const sessionId = "test-session-delta-empty";
      const sessionDir = join(copilotHome, "session-state", sessionId);
      mkdirSync(sessionDir, { recursive: true });

      const events = [
        { type: "assistant.message", data: { content: "Old message" } },
        { type: "user.message", data: { content: "another input" } },
      ];
      writeFileSync(
        join(sessionDir, "events.jsonl"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      const result = extractSessionSummary({
        copilotSessionId: sessionId,
        sinceEventIndex: 1,
        copilotHome: join(copilotHome, "session-state", ".."),
      });

      assert.equal(result.summary, null);
      assert.equal(result.source, "events.jsonl");
      assert.equal(result.lastEventIndex, 2);
    });

    it("GIVEN truncated JSONL trailing line WHEN extracted THEN valid events still parsed", async (t) => {
      const { extractSessionSummary } = await importProjectModule(
        ".github/extensions/copilot-interactive-subagents/lib/summary.mjs",
        ["extractSessionSummary"],
      );

      const copilotHome = createWorkspace(t);
      const sessionId = "test-session-truncated";
      const sessionDir = join(copilotHome, "session-state", sessionId);
      mkdirSync(sessionDir, { recursive: true });

      const content =
        JSON.stringify({ type: "assistant.message", data: { content: "Valid" } }) +
        '\n{"type":"assis';
      writeFileSync(join(sessionDir, "events.jsonl"), content);

      const result = extractSessionSummary({
        copilotSessionId: sessionId,
        copilotHome: join(copilotHome, "session-state", ".."),
      });

      assert.equal(result.summary, "Valid");
      assert.equal(result.lastEventIndex, 1);
    });
  });

  describe("completion pipeline", () => {
    it("GIVEN autonomous completion WHEN closePaneOnCompletion=true THEN closePane is called", async (t) => {
      const workspacePath = createWorkspace(t);
      const { createExtensionHandlers } = await importProjectModule(
        ".github/extensions/copilot-interactive-subagents/extension.mjs",
        ["createExtensionHandlers"],
      );
      const { createStateStore } = await importProjectModule(
        ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
        ["createStateStore"],
      );

      let closePaneCalled = false;
      const handlers = await createExtensionHandlers({
        resolveLaunchBackend: async () => ({ ok: true, selectedBackend: "tmux", action: "attach" }),
        createStateStore: (req) => createStateStore({ workspacePath }),
        openPane: async () => ({ paneId: "%1", visible: true }),
        launchAgentInPane: async () => ({ sessionId: null }),
        readPaneOutput: async () => ({ output: "\n__SUBAGENT_DONE_0__" }),
        closePane: ({ backend, paneId }) => {
          closePaneCalled = true;
          assert.equal(backend, "tmux");
          assert.equal(paneId, "%1");
          return { ok: true };
        },
      });

      const result = await handlers.copilot_subagent_launch({
        workspacePath,
        requestedIdentifier: "test-agent",
        task: "do work",
        enumerateCustomAgents: async () => [{ identifier: "test-agent" }],
        awaitCompletion: true,
      });

      assert.equal(result.ok, true);
      assert.equal(closePaneCalled, true, "closePane should have been called");
    });

    it("GIVEN closePaneOnCompletion=false WHEN completion runs THEN pane is NOT closed", async (t) => {
      const workspacePath = createWorkspace(t);
      const { createExtensionHandlers } = await importProjectModule(
        ".github/extensions/copilot-interactive-subagents/extension.mjs",
        ["createExtensionHandlers"],
      );
      const { createStateStore } = await importProjectModule(
        ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
        ["createStateStore"],
      );

      let closePaneCalled = false;
      const handlers = await createExtensionHandlers({
        resolveLaunchBackend: async () => ({ ok: true, selectedBackend: "tmux", action: "attach" }),
        createStateStore: (req) => createStateStore({ workspacePath }),
        openPane: async () => ({ paneId: "%1", visible: true }),
        launchAgentInPane: async () => ({ sessionId: null }),
        readPaneOutput: async () => ({ output: "\n__SUBAGENT_DONE_0__" }),
        closePane: () => { closePaneCalled = true; return { ok: true }; },
      });

      const result = await handlers.copilot_subagent_launch({
        workspacePath,
        requestedIdentifier: "test-agent",
        task: "do work",
        enumerateCustomAgents: async () => [{ identifier: "test-agent" }],
        awaitCompletion: true,
        closePaneOnCompletion: false,
      });

      assert.equal(result.ok, true);
      assert.equal(closePaneCalled, false, "closePane should NOT have been called");
    });
  });
});
