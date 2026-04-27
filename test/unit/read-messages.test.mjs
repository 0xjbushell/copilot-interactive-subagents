import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { importProjectModule } from "../helpers/red-harness.mjs";

const MOD_PATH = "packages/copilot-interactive-subagents/extension/lib/read-messages.mjs";

function makeMockServices(overrides = {}) {
  return {
    readLaunchRecord: async () => ({ messageCursor: 0 }),
    updateLaunchRecord: async () => {},
    readPingsSince: () => ({ records: [], nextCursor: 0, hasMore: false }),
    stateDir: "/mock/state",
    ...overrides,
  };
}

describe("readMessages (D3)", () => {
  it("uses manifest.messageCursor when sinceCursor omitted", async () => {
    const { readMessages } = await importProjectModule(MOD_PATH, ["readMessages"]);
    let capturedCursor;
    const result = await readMessages({
      launchId: "lch_test",
      services: makeMockServices({
        readLaunchRecord: async () => ({ messageCursor: 100 }),
        readPingsSince: ({ sinceCursor }) => {
          capturedCursor = sinceCursor;
          return {
            records: [{ type: "message", message: "hi", writtenAt: "2026-01-01T00:00:00Z", cursor: 200 }],
            nextCursor: 200,
            hasMore: false,
          };
        },
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(capturedCursor, 100);
    assert.equal(result.messages.length, 1);
    assert.equal(result.nextCursor, 200);
    assert.equal(result.hasMore, false);
  });

  it("reads from sinceCursor=0 (replays all) regardless of manifest cursor", async () => {
    const { readMessages } = await importProjectModule(MOD_PATH, ["readMessages"]);
    let capturedCursor;
    const result = await readMessages({
      launchId: "lch_test",
      sinceCursor: 0,
      services: makeMockServices({
        readLaunchRecord: async () => ({ messageCursor: 500 }),
        readPingsSince: ({ sinceCursor }) => {
          capturedCursor = sinceCursor;
          return {
            records: [
              { type: "message", message: "a", writtenAt: "2026-01-01T00:00:00Z", cursor: 50 },
              { type: "message", message: "b", writtenAt: "2026-01-01T00:00:01Z", cursor: 100 },
            ],
            nextCursor: 100,
            hasMore: false,
          };
        },
      }),
    });
    assert.equal(capturedCursor, 0);
    assert.equal(result.ok, true);
    assert.equal(result.messages.length, 2);
    assert.equal(result.nextCursor, 100);
  });

  it("reads from explicit sinceCursor=N", async () => {
    const { readMessages } = await importProjectModule(MOD_PATH, ["readMessages"]);
    let capturedCursor;
    let persistedCursor;
    const result = await readMessages({
      launchId: "lch_test",
      sinceCursor: 42,
      services: makeMockServices({
        readLaunchRecord: async () => ({ messageCursor: 10 }),
        readPingsSince: ({ sinceCursor }) => {
          capturedCursor = sinceCursor;
          return {
            records: [{ type: "message", message: "c", writtenAt: "2026-01-01T00:00:02Z", cursor: 80 }],
            nextCursor: 80,
            hasMore: false,
          };
        },
        updateLaunchRecord: async (_id, updates) => { persistedCursor = updates.messageCursor; },
      }),
    });
    assert.equal(capturedCursor, 42);
    assert.equal(result.ok, true);
    assert.equal(result.nextCursor, 80);
    assert.equal(persistedCursor, 80);
  });

  it("writes cursor back even on empty reads", async () => {
    const { readMessages } = await importProjectModule(MOD_PATH, ["readMessages"]);
    let persistedCursor;
    const result = await readMessages({
      launchId: "lch_test",
      services: makeMockServices({
        readLaunchRecord: async () => ({ messageCursor: 50 }),
        readPingsSince: () => ({ records: [], nextCursor: 50, hasMore: false }),
        updateLaunchRecord: async (_id, updates) => { persistedCursor = updates.messageCursor; },
      }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.messages, []);
    assert.equal(result.nextCursor, 50);
    assert.equal(persistedCursor, 50);
  });

  it("no pings.jsonl → empty result, cursor persisted as 0", async () => {
    const { readMessages } = await importProjectModule(MOD_PATH, ["readMessages"]);
    let persistedCursor;
    const result = await readMessages({
      launchId: "lch_test",
      services: makeMockServices({
        readLaunchRecord: async () => ({ messageCursor: 0 }),
        readPingsSince: () => ({ records: [], nextCursor: 0, hasMore: false }),
        updateLaunchRecord: async (_id, updates) => { persistedCursor = updates.messageCursor; },
      }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.messages, []);
    assert.equal(result.nextCursor, 0);
    assert.equal(result.hasMore, false);
    assert.equal(persistedCursor, 0);
  });

  it("non-existent launchId → LAUNCH_NOT_FOUND", async () => {
    const { readMessages } = await importProjectModule(MOD_PATH, ["readMessages"]);
    let updateCalled = false;
    const result = await readMessages({
      launchId: "lch_nonexistent",
      services: makeMockServices({
        readLaunchRecord: async () => {
          const err = new Error("Not found");
          err.code = "ENOENT";
          throw err;
        },
        updateLaunchRecord: async () => { updateCalled = true; },
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "LAUNCH_NOT_FOUND");
    assert.equal(updateCalled, false);
  });

  it("invalid cursor (negative) → INVALID_CURSOR", async () => {
    const { readMessages } = await importProjectModule(MOD_PATH, ["readMessages"]);
    const result = await readMessages({
      launchId: "lch_test",
      sinceCursor: -1,
      services: makeMockServices(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "INVALID_CURSOR");
  });

  it("invalid cursor (float) → INVALID_CURSOR", async () => {
    const { readMessages } = await importProjectModule(MOD_PATH, ["readMessages"]);
    const result = await readMessages({
      launchId: "lch_test",
      sinceCursor: 3.14,
      services: makeMockServices(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "INVALID_CURSOR");
  });

  it("persists nextCursor from explicit sinceCursor=0 replay", async () => {
    const { readMessages } = await importProjectModule(MOD_PATH, ["readMessages"]);
    let persistedCursor;
    await readMessages({
      launchId: "lch_test",
      sinceCursor: 0,
      services: makeMockServices({
        readLaunchRecord: async () => ({ messageCursor: 999 }),
        readPingsSince: () => ({ records: [], nextCursor: 0, hasMore: false }),
        updateLaunchRecord: async (_id, updates) => { persistedCursor = updates.messageCursor; },
      }),
    });
    assert.equal(persistedCursor, 0);
  });

  it("does not call updateLaunchRecord on LAUNCH_NOT_FOUND (null manifest)", async () => {
    const { readMessages } = await importProjectModule(MOD_PATH, ["readMessages"]);
    let updateCalled = false;
    const result = await readMessages({
      launchId: "lch_missing",
      services: makeMockServices({
        readLaunchRecord: async () => null,
        updateLaunchRecord: async () => { updateCalled = true; },
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "LAUNCH_NOT_FOUND");
    assert.equal(updateCalled, false);
  });

  it("defaults manifest.messageCursor to 0 when missing from manifest", async () => {
    const { readMessages } = await importProjectModule(MOD_PATH, ["readMessages"]);
    let capturedCursor;
    await readMessages({
      launchId: "lch_test",
      services: makeMockServices({
        readLaunchRecord: async () => ({}),
        readPingsSince: ({ sinceCursor }) => {
          capturedCursor = sinceCursor;
          return { records: [], nextCursor: 0, hasMore: false };
        },
      }),
    });
    assert.equal(capturedCursor, 0);
  });

  it("returns SIDECAR_READ_FAILED when readPingsSince throws", async () => {
    const { readMessages } = await importProjectModule(MOD_PATH, ["readMessages"]);
    const result = await readMessages({
      launchId: "lch_test",
      services: makeMockServices({
        readPingsSince: () => { throw new Error("EACCES: permission denied"); },
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "SIDECAR_READ_FAILED");
    assert.ok(result.message.includes("EACCES"));
  });
});
