import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { importProjectModule } from "./helpers/red-harness.mjs";

async function createTempDir(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function writeLaunchRecord({ workspacePath, record }) {
  const { createStateStore } = await importProjectModule(
    ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
    ["createStateStore"],
  );

  const store = createStateStore({ workspacePath });
  await store.writeLaunchRecord(record);
  return store;
}

describe("resume pane-backed launches from stored metadata", () => {
  it("prefers the workspace manifest over conflicting project-local index metadata", async (t) => {
    const workspacePath = await createTempDir(t, "copilot-interactive-subagents-resume-workspace-");
    const projectRoot = await createTempDir(t, "copilot-interactive-subagents-resume-project-");
    const { planResumeSession } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
      ["planResumeSession"],
    );
    const { createStateIndex } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state-index.mjs",
      ["createStateIndex"],
    );

    await writeLaunchRecord({
      workspacePath,
      record: {
        launchId: "launch-workspace-first",
        agentIdentifier: "reviewer",
        agentKind: "custom",
        backend: "tmux",
        paneId: "%5",
        sessionId: "session-from-workspace",
        requestedAt: "2026-03-19T00:00:00.000Z",
        status: "running",
      },
    });

    const stateIndex = createStateIndex({ projectRoot });
    await stateIndex.writeLaunchIndexEntry({
      launchId: "launch-workspace-first",
      agentIdentifier: "planner",
      agentKind: "custom",
      backend: "zellij",
      paneId: "pane-from-index",
      sessionId: "session-from-index",
      requestedAt: "2026-03-19T00:00:00.000Z",
      status: "running",
      metadataVersion: 3,
      manifestPath: "/tmp/elsewhere/launch-workspace-first.json",
    });

    const plan = await planResumeSession({
      request: {
        launchId: "launch-workspace-first",
        workspacePath,
        projectRoot,
      },
      services: {
        stateIndex,
      },
    });

    assert.equal(plan.ok, true);
    assert.equal(plan.lookupSource, "workspace");
    assert.equal(plan.manifest.agentIdentifier, "reviewer");
    assert.equal(plan.manifest.backend, "tmux");
    assert.equal(plan.manifest.paneId, "%5");
    assert.equal(plan.manifest.sessionId, "session-from-workspace");
  });

  it("falls back to the optional project-local index when the workspace manifest cannot be found", async (t) => {
    const workspacePath = await createTempDir(t, "copilot-interactive-subagents-resume-missing-workspace-");
    const projectRoot = await createTempDir(t, "copilot-interactive-subagents-resume-index-project-");
    const { planResumeSession } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
      ["planResumeSession"],
    );
    const { createStateIndex } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state-index.mjs",
      ["createStateIndex"],
    );

    const stateIndex = createStateIndex({ projectRoot });
    await stateIndex.writeLaunchIndexEntry({
      launchId: "launch-index-fallback",
      agentIdentifier: "reviewer",
      agentKind: "custom",
      backend: "tmux",
      paneId: "%8",
      sessionId: "session-index-only",
      requestedAt: "2026-03-19T00:00:00.000Z",
      status: "running",
      metadataVersion: 3,
      manifestPath: path.join(workspacePath, "missing.json"),
    });

    const plan = await planResumeSession({
      request: {
        launchId: "launch-index-fallback",
        workspacePath,
        projectRoot,
      },
      services: {
        stateIndex,
      },
    });

    assert.equal(plan.ok, true);
    assert.equal(plan.lookupSource, "index");
    assert.equal(plan.manifest.launchId, "launch-index-fallback");
    assert.equal(plan.manifest.sessionId, "session-index-only");
  });

  it("throws MANIFEST_VERSION_UNSUPPORTED when stored metadata uses an unsupported version", async (t) => {
    const workspacePath = await createTempDir(t, "copilot-interactive-subagents-resume-unsupported-");
    const { planResumeSession } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
      ["planResumeSession"],
    );

    await writeLaunchRecord({
      workspacePath,
      record: {
        launchId: "launch-unsupported",
        agentIdentifier: "reviewer",
        agentKind: "custom",
        backend: "tmux",
        paneId: "%6",
        sessionId: "session-unsupported",
        requestedAt: "2026-03-19T00:00:00.000Z",
        status: "running",
        metadataVersion: 99,
      },
    });

    await assert.rejects(
      () => planResumeSession({ request: { launchId: "launch-unsupported", workspacePath } }),
      (err) => err?.code === "MANIFEST_VERSION_UNSUPPORTED" && err.observedVersion === 99,
    );
  });

  it("GIVEN manifest.status === \"failure\" WHEN resume runs THEN probeSessionLiveness is NOT called (terminal-status fix)", async (t) => {
    const workspacePath = await createTempDir(t, "copilot-interactive-subagents-resume-failure-status-");
    const { resumeSubagent } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
      ["resumeSubagent"],
    );

    const stateStore = await writeLaunchRecord({
      workspacePath,
      record: {
        launchId: "launch-failure",
        agentIdentifier: "reviewer",
        agentKind: "custom",
        backend: "tmux",
        paneId: "%11",
        sessionId: "session-failed",
        copilotSessionId: "csid-failure",
        requestedAt: "2026-03-19T00:00:00.000Z",
        status: "failure",
      },
    });

    let probeCalled = false;
    const result = await resumeSubagent({
      request: { launchId: "launch-failure", workspacePath },
      services: {
        stateStore,
        acquireLock: () => ({ release: () => {} }),
        // If the typo regresses ("failed" instead of "failure"), this would be
        // invoked and (returning true) would short-circuit to SESSION_ACTIVE.
        probeSessionLiveness: () => { probeCalled = true; return true; },
        openPaneAndSendCommand: async () => ({ paneId: "%21" }),
        readFileSync: () => { throw new Error("ENOENT"); },
      },
    });

    assert.equal(probeCalled, false, "probeSessionLiveness must not be invoked for status=failure");
    assert.notEqual(result.code, "SESSION_ACTIVE");
    assert.equal(result.status, "interactive");
  });

  it("GIVEN prior stored metadata with copilotSessionId WHEN resume runs THEN it creates new pane and returns interactive status", async (t) => {
    const workspacePath = await createTempDir(t, "copilot-interactive-subagents-resume-success-");
    const { resumeSubagent } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
      ["resumeSubagent"],
    );
    const { createStateStore } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createStateStore"],
    );

    const stateStore = await writeLaunchRecord({
      workspacePath,
      record: {
        launchId: "launch-success",
        agentIdentifier: "reviewer",
        agentKind: "custom",
        backend: "tmux",
        paneId: "%9",
        sessionId: "session-running",
        copilotSessionId: "csid-abc-123",
        requestedAt: "2026-03-19T00:00:00.000Z",
        status: "success",
      },
    });

    const result = await resumeSubagent({
      request: {
        launchId: "launch-success",
        workspacePath,
      },
      services: {
        stateStore,
        acquireLock: () => ({ release: () => {} }),
        probeSessionLiveness: () => false,
        openPaneAndSendCommand: async () => ({ paneId: "%20" }),
        readFileSync: () => { throw new Error("ENOENT"); },
      },
    });

    const stored = await createStateStore({ workspacePath }).readLaunchRecord("launch-success");

    assert.equal(result.ok, true);
    assert.equal(result.status, "interactive");
    assert.equal(result.paneId, "%20");
    assert.equal(result.copilotSessionId, "csid-abc-123");
    assert.equal(stored.status, "interactive");
    assert.equal(stored.paneId, "%20");
  });

  it("GIVEN no openPaneAndSendCommand WHEN openPane + launchAgentInPane exist THEN resume falls back to composing them", async (t) => {
    const workspacePath = await createTempDir(t, "copilot-interactive-subagents-resume-fallback-");
    const { resumeSubagent } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
      ["resumeSubagent"],
    );
    const { createStateStore } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createStateStore"],
    );

    const stateStore = await writeLaunchRecord({
      workspacePath,
      record: {
        launchId: "launch-fallback",
        agentIdentifier: "reviewer",
        agentKind: "custom",
        backend: "tmux",
        paneId: "%9",
        sessionId: null,
        copilotSessionId: "csid-fallback-123",
        requestedAt: "2026-03-19T00:00:00.000Z",
        status: "success",
      },
    });

    const openPaneCalls = [];
    const launchCalls = [];

    const result = await resumeSubagent({
      request: {
        launchId: "launch-fallback",
        workspacePath,
      },
      services: {
        stateStore,
        acquireLock: () => ({ release: () => {} }),
        probeSessionLiveness: () => false,
        openPane: async (ctx) => { openPaneCalls.push(ctx); return { paneId: "%30" }; },
        launchAgentInPane: async (ctx) => { launchCalls.push(ctx); return { sessionId: "new-session" }; },
        readFileSync: () => { throw new Error("ENOENT"); },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "interactive");
    assert.equal(result.paneId, "%30");
    assert.equal(openPaneCalls.length, 1);
    assert.equal(openPaneCalls[0].backend, "tmux");
    assert.equal(launchCalls.length, 1);
    assert.equal(launchCalls[0].paneId, "%30");
    assert.equal(launchCalls[0].copilotSessionId, "csid-fallback-123");
    assert.equal(launchCalls[0].agentIdentifier, "reviewer");

    const stored = await createStateStore({ workspacePath }).readLaunchRecord("launch-fallback");
    assert.equal(stored.paneId, "%30");
    assert.equal(stored.status, "interactive");
  });

  it("GIVEN stored tmux metadata without copilotSessionId WHEN resume runs THEN it returns RESUME_UNSUPPORTED", async (t) => {
    const workspacePath = await createTempDir(t, "copilot-interactive-subagents-resume-sessionless-");
    const { resumeSubagent } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
      ["resumeSubagent"],
    );

    await writeLaunchRecord({
      workspacePath,
      record: {
        launchId: "launch-sessionless",
        agentIdentifier: "reviewer",
        agentKind: "custom",
        backend: "tmux",
        paneId: "%13",
        sessionId: null,
        requestedAt: "2026-03-19T00:00:00.000Z",
        status: "running",
      },
    });

    const result = await resumeSubagent({
      request: {
        launchId: "launch-sessionless",
        workspacePath,
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "RESUME_UNSUPPORTED");
  });

  it("GIVEN workspace metadata remains WHEN resume runs fire-and-forget THEN it returns immediately with interactive status", async (t) => {
    const workspacePath = await createTempDir(t, "copilot-interactive-subagents-resume-cross-session-");
    const { resumeSubagent } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
      ["resumeSubagent"],
    );
    const { createStateStore } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createStateStore"],
    );

    const laterStateStore = createStateStore({ workspacePath });
    await writeLaunchRecord({
      workspacePath,
      record: {
        launchId: "launch-cross-session",
        agentIdentifier: "reviewer",
        agentKind: "custom",
        backend: "tmux",
        paneId: "%10",
        sessionId: "session-cross-session",
        copilotSessionId: "csid-cross",
        requestedAt: "2026-03-19T00:00:00.000Z",
        status: "success",
      },
    });

    const result = await resumeSubagent({
      request: {
        launchId: "launch-cross-session",
        workspacePath,
        awaitCompletion: false,
      },
      services: {
        stateStore: laterStateStore,
        acquireLock: () => ({ release: () => {} }),
        probeSessionLiveness: () => false,
        openPaneAndSendCommand: async () => ({ paneId: "%10" }),
        readFileSync: () => { throw new Error("ENOENT"); },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "interactive");
    assert.equal(result.paneId, "%10");
    assert.equal(result.summarySource, "fallback");
  });

  it("GIVEN session is still active (lock held) WHEN resume is attempted THEN it returns SESSION_ACTIVE", async (t) => {
    const workspacePath = await createTempDir(t, "copilot-interactive-subagents-resume-active-");
    const { resumeSubagent } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
      ["resumeSubagent"],
    );

    await writeLaunchRecord({
      workspacePath,
      record: {
        launchId: "launch-active",
        agentIdentifier: "reviewer",
        agentKind: "custom",
        backend: "tmux",
        paneId: "%11",
        sessionId: "session-active",
        copilotSessionId: "csid-active",
        requestedAt: "2026-03-19T00:00:00.000Z",
        status: "running",
      },
    });

    const result = await resumeSubagent({
      request: {
        launchId: "launch-active",
        workspacePath,
      },
      services: {
        acquireLock: () => {
          const err = new Error("Session is currently active");
          err.code = "SESSION_ACTIVE";
          throw err;
        },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "SESSION_ACTIVE");
    assert.equal(result.status, "failure");
    assert.equal(result.launchId, "launch-active");
  });

  it("GIVEN stored metadata uses an unsupported backend WHEN resume is attempted THEN it is rejected before any runtime command runs", async (t) => {
    const workspacePath = await createTempDir(t, "copilot-interactive-subagents-resume-bad-backend-");
    const { resumeSubagent } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
      ["resumeSubagent"],
    );

    await writeLaunchRecord({
      workspacePath,
      record: {
        launchId: "launch-bad-backend",
        agentIdentifier: "reviewer",
        agentKind: "custom",
        backend: "bad-backend",
        paneId: "%14",
        sessionId: "session-bad",
        requestedAt: "2026-03-19T00:00:00.000Z",
        status: "running",
      },
    });

    const result = await resumeSubagent({
      request: {
        launchId: "launch-bad-backend",
        workspacePath,
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "RESUME_TARGET_INVALID");
    assert.match(result.message, /unsupported backend/i);
  });

  it("GIVEN stored metadata missing required fields WHEN resume is attempted THEN it returns RESUME_TARGET_INVALID", async (t) => {
    const workspacePath = await createTempDir(t, "copilot-interactive-subagents-resume-missing-fields-");
    const { resumeSubagent } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
      ["resumeSubagent"],
    );

    await writeLaunchRecord({
      workspacePath,
      record: {
        launchId: "launch-missing-fields",
        agentIdentifier: null,
        agentKind: "custom",
        backend: "tmux",
        paneId: "%14",
        sessionId: "session-incomplete",
        requestedAt: "2026-03-19T00:00:00.000Z",
        status: "running",
      },
    });

    const result = await resumeSubagent({
      request: {
        launchId: "launch-missing-fields",
        workspacePath,
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "RESUME_TARGET_INVALID");
    assert.match(result.message, /missing/i);
  });

  it("GIVEN pane still alive WHEN resume is attempted THEN it returns SESSION_ACTIVE", async (t) => {
    const workspacePath = await createTempDir(t, "copilot-interactive-subagents-resume-alive-pane-");
    const { resumeSubagent } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
      ["resumeSubagent"],
    );

    await writeLaunchRecord({
      workspacePath,
      record: {
        launchId: "launch-alive-pane",
        agentIdentifier: "reviewer",
        agentKind: "custom",
        backend: "tmux",
        paneId: "%12",
        sessionId: "session-debug",
        copilotSessionId: "csid-alive",
        requestedAt: "2026-03-19T00:00:00.000Z",
        status: "running",
        summary: "Stored summary should stay untouched",
      },
    });

    const result = await resumeSubagent({
      request: {
        launchId: "launch-alive-pane",
        workspacePath,
      },
      services: {
        acquireLock: () => ({ release: () => {} }),
        probeSessionLiveness: () => true,
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "SESSION_ACTIVE");
    assert.equal(result.status, "failure");
  });

  it("GIVEN open pane fails during resume WHEN resume runs THEN it returns a structured failure instead of throwing", async (t) => {
    const workspacePath = await createTempDir(t, "copilot-interactive-subagents-resume-runtime-failure-");
    const { resumeSubagent } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
      ["resumeSubagent"],
    );

    await writeLaunchRecord({
      workspacePath,
      record: {
        launchId: "launch-runtime-failure",
        agentIdentifier: "reviewer",
        agentKind: "custom",
        backend: "tmux",
        paneId: "%15",
        sessionId: "session-runtime",
        copilotSessionId: "csid-runtime",
        requestedAt: "2026-03-19T00:00:00.000Z",
        status: "success",
      },
    });

    const result = await resumeSubagent({
      request: {
        launchId: "launch-runtime-failure",
        workspacePath,
      },
      services: {
        acquireLock: () => ({ release: () => {} }),
        probeSessionLiveness: () => false,
        readFileSync: () => { throw new Error("ENOENT"); },
        openPaneAndSendCommand: async () => {
          throw new Error("pane creation exploded");
        },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "RESUME_RUNTIME_UNAVAILABLE");
    assert.equal(result.launchId, "launch-runtime-failure");
    assert.match(result.message, /exploded/i);
  });
});
