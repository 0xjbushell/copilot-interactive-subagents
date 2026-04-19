import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { importProjectModule } from "../helpers/red-harness.mjs";

const BACKEND_OPS = ".github/extensions/copilot-interactive-subagents/lib/backend-ops.mjs";
const LAUNCH = ".github/extensions/copilot-interactive-subagents/lib/launch.mjs";
const RESUME = ".github/extensions/copilot-interactive-subagents/lib/resume.mjs";

describe("stateDir contract (D1.1 addendum)", () => {
  describe("createDefaultAgentLaunchCommand env propagation", () => {
    it("AC10: includes COPILOT_SUBAGENT_STATE_DIR=<abs> when request.stateDir set", async () => {
      const { createDefaultAgentLaunchCommand } = await importProjectModule(BACKEND_OPS, [
        "createDefaultAgentLaunchCommand",
      ]);
      const cmd = createDefaultAgentLaunchCommand(
        { launchId: "L1", stateDir: "/abs/dir" },
        {},
        { agentIdentifier: "github-copilot", task: "go", copilotSessionId: null, interactive: false, backend: "tmux" },
      );
      assert.match(cmd, /COPILOT_SUBAGENT_STATE_DIR=(?:'|")?\/abs\/dir(?:'|")?/);
    });

    it("omits COPILOT_SUBAGENT_STATE_DIR when request.stateDir unset", async () => {
      const { createDefaultAgentLaunchCommand } = await importProjectModule(BACKEND_OPS, [
        "createDefaultAgentLaunchCommand",
      ]);
      const cmd = createDefaultAgentLaunchCommand(
        { launchId: "L1" },
        {},
        { agentIdentifier: "github-copilot", task: "go", copilotSessionId: null, interactive: false, backend: "tmux" },
      );
      assert.ok(!cmd.includes("COPILOT_SUBAGENT_STATE_DIR"));
    });
  });

  describe("runChildLaunch caller injection (AC11)", () => {
    it("populates request.stateDir before calling launchAgentInPane", async () => {
      const { launchSingleSubagent } = await importProjectModule(LAUNCH, ["launchSingleSubagent"]);

      let capturedRequest;
      const fakeStateStore = {
        writeLaunchRecord: async (rec) => rec,
        updateLaunchRecord: async (_id, patch) => ({
          launchId: "L1",
          agentIdentifier: "github-copilot",
          agentKind: "built-in",
          backend: "tmux",
          paneId: "%1",
          sessionId: null,
          requestedAt: "now",
          status: patch.status ?? "running",
          summary: patch.summary ?? null,
          exitCode: patch.exitCode ?? null,
          metadataVersion: 3,
          ...patch,
        }),
        readLaunchRecord: async () => null,
      };
      const services = {
        stateStore: fakeStateStore,
        stateIndex: { upsert: async () => {} },
        openPane: async () => ({ paneId: "%1" }),
        launchAgentInPane: async ({ request }) => { capturedRequest = request; return { sessionId: null }; },
        readPaneOutput: async () => "",
        readChildSessionState: async () => null,
        closePane: () => {},
      };

      const callerRequest = { task: "do it", awaitCompletion: false, projectRoot: "/foo/bar" };
      const result = await launchSingleSubagent({
        request: callerRequest,
        agentValidation: { identifier: "github-copilot", agentKind: "built-in" },
        backendResolution: { selectedBackend: "tmux", action: "attach" },
        services,
        createLaunchId: () => "L1",
        createCopilotSessionId: () => "cs1",
        now: () => "now",
      });

      assert.ok(result, "result should exist");
      assert.equal(
        capturedRequest.stateDir,
        path.resolve("/foo/bar", ".copilot-interactive-subagents"),
        "request.stateDir should be the canonical path resolved from projectRoot",
      );
      // Caller's request object MUST NOT be mutated (immutability contract)
      assert.equal(callerRequest.stateDir, undefined, "must not mutate caller-supplied request");
    });

    it("forkSession branch sees stateDir already populated (regression for review finding #1)", async () => {
      const { launchSingleSubagent } = await importProjectModule(LAUNCH, ["launchSingleSubagent"]);

      let forkSeenStateDir;
      const services = {
        forkSession: ({ stateDir }) => {
          forkSeenStateDir = stateDir;
          return { ok: true, forkCopilotSessionId: "fork-cs", parentCopilotSessionId: "parent-cs", eventsBaseline: 0 };
        },
        stateStore: {
          writeLaunchRecord: async (rec) => rec,
          updateLaunchRecord: async (_id, patch) => ({
            launchId: "L1", agentIdentifier: "github-copilot", agentKind: "built-in",
            backend: "tmux", paneId: "%1", sessionId: null, requestedAt: "now",
            status: patch.status ?? "running", summary: null, exitCode: null,
            metadataVersion: 3, ...patch,
          }),
          readLaunchRecord: async () => ({ copilotSessionId: "parent-cs" }),
        },
        stateIndex: { upsert: async () => {} },
        openPane: async () => ({ paneId: "%1" }),
        launchAgentInPane: async () => ({ sessionId: null }),
        readPaneOutput: async () => "",
        readChildSessionState: async () => null,
        closePane: () => {},
      };

      await launchSingleSubagent({
        request: {
          task: "go",
          awaitCompletion: false,
          projectRoot: "/foo/bar",
          fork: { launchId: "parent" },
        },
        agentValidation: { identifier: "github-copilot", agentKind: "built-in" },
        backendResolution: { selectedBackend: "tmux", action: "attach" },
        services,
        createLaunchId: () => "L1",
        createCopilotSessionId: () => "cs1",
        now: () => "now",
      });

      assert.equal(
        forkSeenStateDir,
        path.resolve("/foo/bar", ".copilot-interactive-subagents"),
        "forkSession must receive the canonical stateDir, not undefined",
      );
    });
  });

  describe("openResumePane caller injection (AC12)", () => {
    it("openPaneAndSendCommand branch receives stateDir on request", async () => {
      const { resumeSubagent } = await importProjectModule(RESUME, ["resumeSubagent"]);

      const manifest = {
        launchId: "L1",
        backend: "tmux",
        agentIdentifier: "github-copilot",
        agentKind: "built-in",
        paneId: "%1",
        sessionId: "s",
        copilotSessionId: "cs1",
        status: "success",
        summary: "x",
        exitCode: 0,
        metadataVersion: 3,
        closePaneOnCompletion: false,
      };

      let capturedRequest;
      const services = {
        stateStore: {
          readLaunchRecord: async () => manifest,
          updateLaunchRecord: async (_id, patch) => ({ ...manifest, ...patch }),
        },
        stateIndex: { lookupEntry: () => null, upsert: async () => {} },
        acquireLock: () => ({ release: () => {} }),
        probeSessionLiveness: () => false,
        openPaneAndSendCommand: async ({ request }) => {
          capturedRequest = request;
          return { paneId: "%2", sessionId: "s2" };
        },
        readPaneOutput: async () => "__SUBAGENT_DONE_0__",
        readChildSessionState: async () => null,
        closePane: () => {},
        unlinkSync: () => {},
        readFileSync: () => "",
      };

      await resumeSubagent({
        request: { launchId: "L1", projectRoot: "/foo/bar" },
        services,
      });

      assert.ok(capturedRequest, "openPaneAndSendCommand should have been called");
      assert.equal(
        capturedRequest.stateDir,
        path.resolve("/foo/bar", ".copilot-interactive-subagents"),
        "openPaneAndSendCommand branch should see request.stateDir",
      );
    });

    it("does not mutate caller-supplied request (immutability contract)", async () => {
      const { resumeSubagent } = await importProjectModule(RESUME, ["resumeSubagent"]);
      const manifest = {
        launchId: "L1", backend: "tmux", agentIdentifier: "github-copilot",
        agentKind: "built-in", paneId: "%1", sessionId: "s", copilotSessionId: "cs1",
        status: "success", summary: "x", exitCode: 0, metadataVersion: 3,
        closePaneOnCompletion: false,
      };
      const services = {
        stateStore: {
          readLaunchRecord: async () => manifest,
          updateLaunchRecord: async (_id, patch) => ({ ...manifest, ...patch }),
        },
        stateIndex: { lookupEntry: () => null, upsert: async () => {} },
        acquireLock: () => ({ release: () => {} }),
        probeSessionLiveness: () => false,
        openPaneAndSendCommand: async () => ({ paneId: "%2", sessionId: "s2" }),
        readPaneOutput: async () => "__SUBAGENT_DONE_0__",
        readChildSessionState: async () => null,
        closePane: () => {},
        unlinkSync: () => {},
        readFileSync: () => "",
      };
      const callerRequest = { launchId: "L1", projectRoot: "/foo/bar" };
      await resumeSubagent({ request: callerRequest, services });
      assert.equal(callerRequest.stateDir, undefined, "must not mutate caller-supplied request");
    });

    it("fallback launchAgentInPane branch receives stateDir on request", async () => {
      const { resumeSubagent } = await importProjectModule(RESUME, ["resumeSubagent"]);

      const manifest = {
        launchId: "L1",
        backend: "tmux",
        agentIdentifier: "github-copilot",
        agentKind: "built-in",
        paneId: "%1",
        sessionId: "s",
        copilotSessionId: "cs1",
        status: "success",
        summary: "x",
        exitCode: 0,
        metadataVersion: 3,
        closePaneOnCompletion: false,
      };

      let capturedRequest;
      const services = {
        stateStore: {
          readLaunchRecord: async () => manifest,
          updateLaunchRecord: async (_id, patch) => ({ ...manifest, ...patch }),
        },
        stateIndex: { lookupEntry: () => null, upsert: async () => {} },
        acquireLock: () => ({ release: () => {} }),
        probeSessionLiveness: () => false,
        // No openPaneAndSendCommand provided → fallback path
        openPane: async () => ({ paneId: "%2" }),
        launchAgentInPane: async ({ request }) => { capturedRequest = request; return { sessionId: null }; },
        readPaneOutput: async () => "__SUBAGENT_DONE_0__",
        readChildSessionState: async () => null,
        closePane: () => {},
        unlinkSync: () => {},
        readFileSync: () => "",
      };

      await resumeSubagent({
        request: { launchId: "L1", projectRoot: "/foo/bar" },
        services,
      });

      assert.ok(capturedRequest, "launchAgentInPane should have been called");
      assert.equal(
        capturedRequest.stateDir,
        path.resolve("/foo/bar", ".copilot-interactive-subagents"),
        "fallback branch should see same canonical stateDir",
      );
    });
  });

  describe("AC13 path agreement (round-trip)", () => {
    it("child writes via env path; parent reads via same path", async () => {
      const { resolveStateDir, writeExitSidecar, readExitSidecar } = await importProjectModule(
        ".github/extensions/copilot-interactive-subagents/lib/exit-sidecar.mjs",
        ["resolveStateDir", "writeExitSidecar", "readExitSidecar"],
      );
      const { mkdtempSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const projectRoot = mkdtempSync(path.join(tmpdir(), "agreement-"));
      try {
        const parentResolved = resolveStateDir({ projectRoot });
        // Simulate child reading env var:
        process.env.COPILOT_SUBAGENT_STATE_DIR = parentResolved;
        try {
          const childStateDir = process.env.COPILOT_SUBAGENT_STATE_DIR;
          writeExitSidecar({ launchId: "Lr", type: "done", summary: "ok", exitCode: 0, stateDir: childStateDir });
          const observed = readExitSidecar({ launchId: "Lr", stateDir: parentResolved });
          assert.ok(observed);
          assert.equal(observed.summary, "ok");
        } finally {
          delete process.env.COPILOT_SUBAGENT_STATE_DIR;
        }
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });
});
