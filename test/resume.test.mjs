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
      metadataVersion: 1,
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
      metadataVersion: 1,
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

  it("returns RESUME_UNSUPPORTED when stored metadata uses an unsupported version", async (t) => {
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

    const plan = await planResumeSession({
      request: {
        launchId: "launch-unsupported",
        workspacePath,
      },
    });

    assert.deepEqual(
      {
        ok: plan.ok,
        code: plan.code,
        launchId: plan.launchId,
      },
      {
        ok: false,
        code: "RESUME_UNSUPPORTED",
        launchId: "launch-unsupported",
      },
    );
    assert.match(plan.message, /metadata/i);
  });

  it("GIVEN prior stored metadata and a valid child session WHEN resume runs THEN it restores the pane-backed interaction and returns updated metadata", async (t) => {
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
        requestedAt: "2026-03-19T00:00:00.000Z",
        status: "running",
      },
    });

    const result = await resumeSubagent({
      request: {
        launchId: "launch-success",
        workspacePath,
        awaitCompletion: true,
      },
      services: {
        stateStore,
        probeResumeTarget: async ({ manifest }) => {
          assert.equal(manifest.launchId, "launch-success");
          return { ok: true };
        },
        reattachResumeTarget: async ({ manifest }) => {
          assert.equal(manifest.paneId, "%9");
          return {
            paneId: "%9",
            paneVisible: true,
            sessionId: "session-running",
          };
        },
        readPaneOutput: async ({ paneId, sessionId }) => {
          assert.equal(paneId, "%9");
          assert.equal(sessionId, "session-running");
          return {
            output: "assistant: Resumed the running reviewer session\n__SUBAGENT_DONE_0__",
          };
        },
      },
    });

    const stored = await createStateStore({ workspacePath }).readLaunchRecord("launch-success");

    assert.deepEqual(result, {
      ok: true,
      launchId: "launch-success",
      status: "success",
      agentIdentifier: "reviewer",
      agentKind: "custom",
      backend: "tmux",
      paneId: "%9",
      paneVisible: true,
      sessionId: "session-running",
      summary: "Resumed the running reviewer session",
      summarySource: "assistant-message",
      exitCode: 0,
      metadataVersion: 1,
      resumePointer: {
        launchId: "launch-success",
        sessionId: "session-running",
        agentIdentifier: "reviewer",
        backend: "tmux",
        paneId: "%9",
        manifestPath: path.join(
          workspacePath,
          ".copilot-interactive-subagents",
          "launches",
          "launch-success.json",
        ),
      },
    });
    assert.equal(stored.status, "success");
    assert.equal(stored.summary, "Resumed the running reviewer session");
    assert.equal(stored.exitCode, 0);
  });

  it("GIVEN stored tmux metadata without a child session id WHEN resume runs THEN it can still reattach and monitor by pane", async (t) => {
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
        awaitCompletion: true,
      },
      services: {
        probeResumeTarget: async () => ({ ok: true }),
        reattachResumeTarget: async () => ({
          paneId: "%13",
          paneVisible: true,
          sessionId: null,
        }),
        readPaneOutput: async ({ paneId, sessionId }) => {
          assert.equal(paneId, "%13");
          assert.equal(sessionId, null);
          return {
            output: "assistant: Sessionless tmux resume still completed\n__SUBAGENT_DONE_0__",
          };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "success");
    assert.equal(result.sessionId, null);
    assert.equal(result.summary, "Sessionless tmux resume still completed");
  });

  it("GIVEN the parent session changes and only workspace metadata remains WHEN resume runs THEN it still succeeds without a project-local index", async (t) => {
    const workspacePath = await createTempDir(t, "copilot-interactive-subagents-resume-cross-session-");
    const { resumeSubagent } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
      ["resumeSubagent"],
    );
    const { createStateStore } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createStateStore"],
    );

    await writeLaunchRecord({
      workspacePath,
      record: {
        launchId: "launch-cross-session",
        agentIdentifier: "reviewer",
        agentKind: "custom",
        backend: "tmux",
        paneId: "%10",
        sessionId: "session-cross-session",
        requestedAt: "2026-03-19T00:00:00.000Z",
        status: "running",
      },
    });

    const laterStateStore = createStateStore({ workspacePath });
    const result = await resumeSubagent({
      request: {
        launchId: "launch-cross-session",
        workspacePath,
        awaitCompletion: false,
      },
      services: {
        stateStore: laterStateStore,
        probeResumeTarget: async () => ({ ok: true }),
        reattachResumeTarget: async () => ({
          paneId: "%10",
          paneVisible: true,
          sessionId: "session-cross-session",
        }),
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "running");
    assert.equal(result.paneId, "%10");
    assert.equal(result.sessionId, "session-cross-session");
    assert.equal(result.summarySource, "fallback");
    assert.match(result.summary, /running/i);
  });

  it("GIVEN stale stored metadata WHEN resume is attempted THEN it returns RESUME_TARGET_INVALID instead of a success-shaped result", async (t) => {
    const workspacePath = await createTempDir(t, "copilot-interactive-subagents-resume-invalid-");
    const { resumeSubagent } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
      ["resumeSubagent"],
    );

    await writeLaunchRecord({
      workspacePath,
      record: {
        launchId: "launch-invalid",
        agentIdentifier: "reviewer",
        agentKind: "custom",
        backend: "tmux",
        paneId: "%11",
        sessionId: "session-stale",
        requestedAt: "2026-03-19T00:00:00.000Z",
        status: "running",
      },
    });

    const result = await resumeSubagent({
      request: {
        launchId: "launch-invalid",
        workspacePath,
      },
      services: {
        probeResumeTarget: async () => ({
          ok: false,
          reason: "session session-stale is no longer available",
        }),
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "RESUME_TARGET_INVALID");
    assert.equal(result.status, "failure");
    assert.equal(result.launchId, "launch-invalid");
    assert.match(result.message, /session-stale/);
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
      services: {
        probeResumeTarget: async () => {
          assert.fail("unsupported resume metadata should fail before probe");
        },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "RESUME_TARGET_INVALID");
    assert.match(result.message, /unsupported backend/i);
  });

  it("GIVEN pane reattach fails WHEN resume is attempted THEN it returns RESUME_ATTACH_FAILED and preserves stored metadata for debugging", async (t) => {
    const workspacePath = await createTempDir(t, "copilot-interactive-subagents-resume-attach-failure-");
    const { resumeSubagent } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
      ["resumeSubagent"],
    );
    const { createStateStore } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createStateStore"],
    );

    await writeLaunchRecord({
      workspacePath,
      record: {
        launchId: "launch-attach-failure",
        agentIdentifier: "reviewer",
        agentKind: "custom",
        backend: "tmux",
        paneId: "%12",
        sessionId: "session-debug",
        requestedAt: "2026-03-19T00:00:00.000Z",
        status: "running",
        summary: "Stored summary should stay untouched",
      },
    });

    const result = await resumeSubagent({
      request: {
        launchId: "launch-attach-failure",
        workspacePath,
      },
      services: {
        probeResumeTarget: async () => ({ ok: true }),
        reattachResumeTarget: async () => {
          throw new Error("tmux attach failed");
        },
      },
    });

    const stored = await createStateStore({ workspacePath }).readLaunchRecord("launch-attach-failure");

    assert.equal(result.ok, false);
    assert.equal(result.code, "RESUME_ATTACH_FAILED");
    assert.equal(result.status, "failure");
    assert.match(result.message, /attach failed/i);
    assert.equal(stored.status, "running");
    assert.equal(stored.summary, "Stored summary should stay untouched");
    assert.equal(stored.sessionId, "session-debug");
  });

  it("GIVEN pane monitoring throws during resume WHEN resume runs THEN it returns a structured failure instead of throwing", async (t) => {
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
        requestedAt: "2026-03-19T00:00:00.000Z",
        status: "running",
      },
    });

    const result = await resumeSubagent({
      request: {
        launchId: "launch-runtime-failure",
        workspacePath,
        awaitCompletion: true,
      },
      services: {
        probeResumeTarget: async () => ({ ok: true }),
        reattachResumeTarget: async () => ({
          paneId: "%15",
          paneVisible: true,
          sessionId: "session-runtime",
        }),
        readPaneOutput: async () => {
          throw new Error("pane output monitoring exploded");
        },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "RESUME_RUNTIME_UNAVAILABLE");
    assert.equal(result.launchId, "launch-runtime-failure");
    assert.match(result.message, /monitoring exploded/i);
  });
});
