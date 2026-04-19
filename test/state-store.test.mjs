import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { importProjectModule } from "./helpers/red-harness.mjs";

async function createWorkspace(t) {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), "copilot-interactive-subagents-state-"));
  t.after(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  return workspacePath;
}

describe("launch state persistence", () => {
  it("serializes launch manifests with the required stable fields", async () => {
    const { createLaunchRecord, serializeLaunchRecord } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createLaunchRecord", "serializeLaunchRecord"],
    );

    const record = createLaunchRecord({
      launchId: "launch-123",
      agentIdentifier: "reviewer",
      agentKind: "custom",
      backend: "tmux",
      paneId: "%1",
      sessionId: null,
      requestedAt: "2026-03-19T00:00:00.000Z",
      status: "pending",
      summary: null,
      exitCode: null,
    });

    assert.deepEqual(JSON.parse(serializeLaunchRecord(record)), {
      launchId: "launch-123",
      agentIdentifier: "reviewer",
      agentKind: "custom",
      backend: "tmux",
      paneId: "%1",
      sessionId: null,
      requestedAt: "2026-03-19T00:00:00.000Z",
      status: "pending",
      summary: null,
      exitCode: null,
      metadataVersion: 3,
      copilotSessionId: null,
      interactive: false,
      fork: null,
      closePaneOnCompletion: true,
      eventsBaseline: null,
      pingHistory: [],
      lastExitType: null,
      sidecarPath: null,
    });
  });

  it("updates launch manifests across state transitions without losing stored metadata", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { createLaunchRecord, createStateStore } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createLaunchRecord", "createStateStore"],
    );

    const store = createStateStore({ workspacePath });
    await store.writeLaunchRecord(
      createLaunchRecord({
        launchId: "launch-456",
        agentIdentifier: "reviewer",
        agentKind: "custom",
        backend: "tmux",
        paneId: "%4",
        sessionId: null,
        requestedAt: "2026-03-19T00:00:00.000Z",
        status: "pending",
      }),
    );
    await store.updateLaunchRecord("launch-456", {
      sessionId: "session-456",
      status: "running",
    });
    await store.updateLaunchRecord("launch-456", {
      status: "success",
      summary: "Completed the requested review",
      exitCode: 0,
    });

    const stored = await store.readLaunchRecord("launch-456");

    assert.deepEqual(stored, {
      launchId: "launch-456",
      agentIdentifier: "reviewer",
      agentKind: "custom",
      backend: "tmux",
      paneId: "%4",
      sessionId: "session-456",
      requestedAt: "2026-03-19T00:00:00.000Z",
      status: "success",
      summary: "Completed the requested review",
      exitCode: 0,
      metadataVersion: 3,
      copilotSessionId: null,
      interactive: false,
      fork: null,
      closePaneOnCompletion: true,
      eventsBaseline: null,
      pingHistory: [],
      lastExitType: null,
      sidecarPath: null,
    });
  });

  it("constructs a resume pointer from persisted launch metadata", async () => {
    const { buildResumePointer } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["buildResumePointer"],
    );

    assert.deepEqual(
      buildResumePointer(
        {
          launchId: "launch-789",
          agentIdentifier: "reviewer",
          backend: "tmux",
          paneId: "%7",
          sessionId: "session-789",
        },
        { workspacePath: "/tmp/workspace" },
      ),
      {
        launchId: "launch-789",
        sessionId: "session-789",
        agentIdentifier: "reviewer",
        backend: "tmux",
        paneId: "%7",
        manifestPath: path.join(
          "/tmp/workspace",
          ".copilot-interactive-subagents",
          "launches",
          "launch-789.json",
        ),
      },
    );
  });

  it("reads an unfinished launch record from a fresh store instance after the original caller has gone away", async (t) => {
    const workspacePath = await createWorkspace(t);
    const { createLaunchRecord, createStateStore } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createLaunchRecord", "createStateStore"],
    );

    const firstStore = createStateStore({ workspacePath });
    await firstStore.writeLaunchRecord(
      createLaunchRecord({
        launchId: "launch-999",
        agentIdentifier: "reviewer",
        agentKind: "custom",
        backend: "tmux",
        paneId: "%9",
        sessionId: "session-999",
        requestedAt: "2026-03-19T00:00:00.000Z",
        status: "running",
      }),
    );

    const secondStore = createStateStore({ workspacePath });
    const stored = await secondStore.readLaunchRecord("launch-999");

    assert.equal(stored.status, "running");
    assert.equal(stored.summary, null);
    assert.equal(stored.exitCode, null);
    assert.equal(stored.sessionId, "session-999");
  });

  it("rejects launch identifiers that would escape the manifest store", async () => {
    const { createStateStore } = await importProjectModule(
      ".github/extensions/copilot-interactive-subagents/lib/state.mjs",
      ["createStateStore"],
    );

    const store = createStateStore({ workspacePath: "/tmp/workspace" });

    await assert.rejects(
      () => store.readLaunchRecord("../outside"),
      /launchId must use only letters, numbers, periods, underscores, and hyphens/,
    );
  });
});
