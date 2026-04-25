import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { importProjectModule } from "../helpers/red-harness.mjs";

const STATE_MODULE = "packages/copilot-interactive-subagents/extension/lib/state.mjs";
const RESUME_MODULE = "packages/copilot-interactive-subagents/extension/lib/resume.mjs";

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("D1.2 manifest v3 contract", () => {
  it("createLaunchRecord defaults metadataVersion to 3 with new v2 fields", async () => {
    const { createLaunchRecord, METADATA_VERSION } = await importProjectModule(
      STATE_MODULE,
      ["createLaunchRecord", "METADATA_VERSION"],
    );

    assert.equal(METADATA_VERSION, 3);

    const record = createLaunchRecord({
      launchId: "x1",
      agentIdentifier: "a",
      agentKind: "custom",
      backend: "tmux",
      paneId: "%1",
      requestedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.equal(record.metadataVersion, 3);
    assert.deepEqual(record.pingHistory, []);
    assert.equal(record.lastExitType, null);
    assert.equal(record.sidecarPath, null);
  });

  it("preserves explicitly supplied v2 fields and clones pingHistory", async () => {
    const { createLaunchRecord } = await importProjectModule(STATE_MODULE, ["createLaunchRecord"]);
    const sourcePings = [{ ts: "2026-01-01T00:00:00.000Z", message: "hi" }];

    const record = createLaunchRecord({
      launchId: "x2",
      agentIdentifier: "a", agentKind: "custom", backend: "tmux", paneId: "%1",
      requestedAt: "2026-01-01T00:00:00.000Z",
      pingHistory: sourcePings,
      lastExitType: "ping",
      sidecarPath: "/tmp/x.json",
    });

    assert.deepEqual(record.pingHistory, sourcePings);
    assert.notEqual(record.pingHistory, sourcePings, "pingHistory must be cloned");
    assert.equal(record.lastExitType, "ping");
    assert.equal(record.sidecarPath, "/tmp/x.json");
  });

  it("v3 record round-trips through writeLaunchRecord/readLaunchRecord", async (t) => {
    const workspacePath = await tempDir(t, "v3-roundtrip-");
    const { createLaunchRecord, createStateStore } = await importProjectModule(
      STATE_MODULE,
      ["createLaunchRecord", "createStateStore"],
    );
    const store = createStateStore({ workspacePath });
    await store.writeLaunchRecord(createLaunchRecord({
      launchId: "roundtrip", agentIdentifier: "a", agentKind: "custom",
      backend: "tmux", paneId: "%1", requestedAt: "2026-01-01T00:00:00.000Z",
      pingHistory: [{ ts: "t1", message: "first" }],
      lastExitType: "ping",
      sidecarPath: "/tmp/exit/roundtrip.json",
    }));
    const read = await store.readLaunchRecord("roundtrip");
    assert.equal(read.metadataVersion, 3);
    assert.deepEqual(read.pingHistory, [{ ts: "t1", message: "first" }]);
    assert.equal(read.lastExitType, "ping");
    assert.equal(read.sidecarPath, "/tmp/exit/roundtrip.json");
  });

  it("readLaunchRecord throws MANIFEST_VERSION_UNSUPPORTED on a v2 manifest on disk", async (t) => {
    const workspacePath = await tempDir(t, "v2-rejection-");
    const { createStateStore } = await importProjectModule(STATE_MODULE, ["createStateStore"]);
    const store = createStateStore({ workspacePath });

    const dir = path.join(workspacePath, ".copilot-interactive-subagents", "launches");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "legacy.json"), JSON.stringify({
      launchId: "legacy", agentIdentifier: "a", agentKind: "custom",
      backend: "tmux", paneId: "%1", sessionId: null,
      requestedAt: "2026-01-01T00:00:00.000Z", status: "success",
      summary: null, exitCode: 0, metadataVersion: 2,
    }));

    await assert.rejects(
      () => store.readLaunchRecord("legacy"),
      (err) => err?.code === "MANIFEST_VERSION_UNSUPPORTED" && err.observedVersion === 2,
    );
  });

  it("readLaunchRecord throws MANIFEST_VERSION_UNSUPPORTED on a v1 manifest on disk", async (t) => {
    const workspacePath = await tempDir(t, "v1-rejection-");
    const { createStateStore } = await importProjectModule(STATE_MODULE, ["createStateStore"]);
    const store = createStateStore({ workspacePath });

    const dir = path.join(workspacePath, ".copilot-interactive-subagents", "launches");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "ancient.json"), JSON.stringify({
      launchId: "ancient", metadataVersion: 1, status: "success",
    }));

    await assert.rejects(
      () => store.readLaunchRecord("ancient"),
      (err) => err?.code === "MANIFEST_VERSION_UNSUPPORTED" && err.observedVersion === 1,
    );
  });

  it("assertSupportedMetadataVersion accepts v3 silently", async () => {
    const { assertSupportedMetadataVersion } = await importProjectModule(
      STATE_MODULE,
      ["assertSupportedMetadataVersion"],
    );
    // No throw.
    assertSupportedMetadataVersion({ metadataVersion: 3 });
  });

  it("planResumeSession throws MANIFEST_VERSION_UNSUPPORTED for state-index path with v2 entry", async (t) => {
    const workspacePath = await tempDir(t, "index-v2-rejection-workspace-");
    const projectRoot = await tempDir(t, "index-v2-rejection-project-");
    const { planResumeSession } = await importProjectModule(RESUME_MODULE, ["planResumeSession"]);
    const { createStateIndex } = await importProjectModule(
      "packages/copilot-interactive-subagents/extension/lib/state-index.mjs",
      ["createStateIndex"],
    );

    const stateIndex = createStateIndex({ projectRoot });
    await stateIndex.writeLaunchIndexEntry({
      launchId: "via-index", agentIdentifier: "a", agentKind: "custom",
      backend: "tmux", paneId: "%1", sessionId: "s",
      requestedAt: "2026-01-01T00:00:00.000Z", status: "running",
      metadataVersion: 2, manifestPath: path.join(workspacePath, "missing.json"),
    });

    await assert.rejects(
      () => planResumeSession({
        request: { launchId: "via-index", workspacePath, projectRoot },
        services: { stateIndex },
      }),
      (err) => err?.code === "MANIFEST_VERSION_UNSUPPORTED",
    );
  });
});
