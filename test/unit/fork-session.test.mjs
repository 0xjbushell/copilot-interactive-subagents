import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { importProjectModule } from "../helpers/red-harness.mjs";

const FORK_PATH = ".github/extensions/copilot-interactive-subagents/lib/fork-session.mjs";

async function createParentSession(t, { copilotHome, sessionId, events = [], yamlContent }) {
  const sessionDir = path.join(copilotHome, "session-state", sessionId);
  await mkdir(sessionDir, { recursive: true });
  if (events.length > 0) {
    await writeFile(path.join(sessionDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }
  if (yamlContent) {
    await writeFile(path.join(sessionDir, "workspace.yaml"), yamlContent);
  }
  t.after(async () => {
    await rm(path.join(copilotHome, "session-state"), { recursive: true, force: true });
  });
  return sessionDir;
}

describe("Fork session", () => {
  it("GIVEN parent session with events WHEN fork called THEN child has copied events and new UUID", async (t) => {
    const copilotHome = await mkdtemp(path.join(os.tmpdir(), "fork-test-"));
    t.after(async () => rm(copilotHome, { recursive: true, force: true }));
    const parentId = "parent-uuid-001";
    const childId = "child-uuid-001";

    await createParentSession(t, {
      copilotHome,
      sessionId: parentId,
      events: [{ type: "user.message" }, { type: "assistant.message" }, { type: "tool.call" }],
      yamlContent: `id: ${parentId}\nname: test-session\n`,
    });

    const { forkSession } = await importProjectModule(FORK_PATH, ["forkSession"]);

    const result = forkSession({
      parentCopilotSessionId: parentId,
      copilotHome,
      services: {
        acquireLock: () => ({ release: () => {} }),
        generateId: () => childId,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.forkCopilotSessionId, childId);
    assert.equal(result.eventsBaseline, 3);
    assert.equal(result.parentCopilotSessionId, parentId);

    // Verify child has events
    const childEvents = readFileSync(path.join(copilotHome, "session-state", childId, "events.jsonl"), "utf8");
    assert.equal(childEvents.split("\n").filter((l) => l.trim()).length, 3);

    // Verify child workspace.yaml has new UUID
    const childYaml = readFileSync(path.join(copilotHome, "session-state", childId, "workspace.yaml"), "utf8");
    assert.ok(childYaml.includes(`id: ${childId}`));
    assert.ok(!childYaml.includes(`id: ${parentId}`));

    // Verify parent is untouched
    const parentEvents = readFileSync(path.join(copilotHome, "session-state", parentId, "events.jsonl"), "utf8");
    assert.equal(parentEvents.split("\n").filter((l) => l.trim()).length, 3);
    const parentYaml = readFileSync(path.join(copilotHome, "session-state", parentId, "workspace.yaml"), "utf8");
    assert.ok(parentYaml.includes(`id: ${parentId}`));
  });

  it("GIVEN non-existent parent session WHEN fork called THEN returns FORK_NOT_FOUND", async (t) => {
    const copilotHome = await mkdtemp(path.join(os.tmpdir(), "fork-test-"));
    t.after(async () => rm(copilotHome, { recursive: true, force: true }));

    const { forkSession } = await importProjectModule(FORK_PATH, ["forkSession"]);

    const result = forkSession({
      parentCopilotSessionId: "nonexistent-uuid",
      copilotHome,
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "FORK_NOT_FOUND");
  });

  it("GIVEN no parentCopilotSessionId WHEN fork called THEN returns FORK_INVALID", async (t) => {
    const { forkSession } = await importProjectModule(FORK_PATH, ["forkSession"]);

    const result = forkSession({});

    assert.equal(result.ok, false);
    assert.equal(result.code, "FORK_INVALID");
  });

  it("GIVEN copy fails WHEN fork called THEN temp cleaned up and FORK_FAILED returned", async (t) => {
    const copilotHome = await mkdtemp(path.join(os.tmpdir(), "fork-test-"));
    t.after(async () => rm(copilotHome, { recursive: true, force: true }));
    const parentId = "parent-copy-fail";

    await createParentSession(t, {
      copilotHome,
      sessionId: parentId,
      events: [{ type: "user.message" }],
    });

    const { forkSession } = await importProjectModule(FORK_PATH, ["forkSession"]);

    let rmSyncCalled = false;
    const result = forkSession({
      parentCopilotSessionId: parentId,
      copilotHome,
      services: {
        acquireLock: () => ({ release: () => {} }),
        generateId: () => "child-fail",
        cpSync: () => { throw new Error("disk full"); },
        rmSync: () => { rmSyncCalled = true; },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "FORK_FAILED");
    assert.match(result.message, /disk full/);
    assert.equal(rmSyncCalled, true);
  });

  it("GIVEN parent session locked WHEN fork called THEN returns SESSION_ACTIVE", async (t) => {
    const copilotHome = await mkdtemp(path.join(os.tmpdir(), "fork-test-"));
    t.after(async () => rm(copilotHome, { recursive: true, force: true }));
    const parentId = "parent-locked";

    await createParentSession(t, {
      copilotHome,
      sessionId: parentId,
      events: [{ type: "user.message" }],
    });

    const { forkSession } = await importProjectModule(FORK_PATH, ["forkSession"]);

    const result = forkSession({
      parentCopilotSessionId: parentId,
      copilotHome,
      services: {
        acquireLock: () => {
          const err = new Error("locked");
          err.code = "SESSION_ACTIVE";
          throw err;
        },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "SESSION_ACTIVE");
  });

  it("GIVEN empty parent session WHEN fork called THEN succeeds with 0 events", async (t) => {
    const copilotHome = await mkdtemp(path.join(os.tmpdir(), "fork-test-"));
    t.after(async () => rm(copilotHome, { recursive: true, force: true }));
    const parentId = "parent-empty";

    await createParentSession(t, {
      copilotHome,
      sessionId: parentId,
      events: [],
    });

    const { forkSession } = await importProjectModule(FORK_PATH, ["forkSession"]);

    const result = forkSession({
      parentCopilotSessionId: parentId,
      copilotHome,
      services: {
        acquireLock: () => ({ release: () => {} }),
        generateId: () => "child-empty",
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.eventsBaseline, 0);
  });
});
