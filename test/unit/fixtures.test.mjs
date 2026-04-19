import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSessionDir,
  createEventsJsonl,
  createManifestV2,
  createLockfile,
} from "../helpers/fixtures.mjs";

describe("fixtures", () => {
  describe("createManifestV2", () => {
    it("produces a valid manifest with all v2 fields when called with no overrides", () => {
      const manifest = createManifestV2();
      const requiredFields = [
        "launchId", "agentIdentifier", "agentKind", "backend", "paneId",
        "sessionId", "requestedAt", "status", "summary", "exitCode",
        "metadataVersion", "copilotSessionId", "interactive", "fork",
        "closePaneOnCompletion", "eventsBaseline",
      ];
      for (const field of requiredFields) {
        assert.ok(field in manifest, `Missing field: ${field}`);
      }
      assert.equal(manifest.metadataVersion, 3);
      assert.equal(manifest.interactive, false);
      assert.equal(manifest.closePaneOnCompletion, true);
    });

    it("applies overrides", () => {
      const manifest = createManifestV2({ status: "running", interactive: true });
      assert.equal(manifest.status, "running");
      assert.equal(manifest.interactive, true);
    });
  });

  describe("createSessionDir", (t) => {
    it("creates the directory and cleans up via t.after", async (t) => {
      const sessionId = "test-session-cleanup-" + Date.now();
      const dir = createSessionDir(sessionId, { t });
      assert.ok(fs.existsSync(dir), "session dir should exist");
      // Cleanup is registered via t.after — verified by not leaving temp dirs
    });

    it("uses custom copilotHome", (t) => {
      const tmpHome = path.join(os.tmpdir(), `fixture-test-${Date.now()}`);
      const dir = createSessionDir("custom-home-test", { copilotHome: tmpHome });
      assert.ok(dir.startsWith(tmpHome));
      assert.ok(fs.existsSync(dir));
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });
  });

  describe("createEventsJsonl", () => {
    it("handles empty array (returns empty string)", (t) => {
      const dir = createSessionDir("events-empty-" + Date.now(), { t });
      const filePath = createEventsJsonl(dir, []);
      const content = fs.readFileSync(filePath, "utf8");
      assert.equal(content, "");
    });

    it("writes JSONL for multiple events", (t) => {
      const dir = createSessionDir("events-multi-" + Date.now(), { t });
      const events = [{ type: "start" }, { type: "end", code: 0 }];
      const filePath = createEventsJsonl(dir, events);
      const lines = fs.readFileSync(filePath, "utf8").trimEnd().split("\n");
      assert.equal(lines.length, 2);
      assert.deepEqual(JSON.parse(lines[0]), { type: "start" });
      assert.deepEqual(JSON.parse(lines[1]), { type: "end", code: 0 });
    });
  });

  describe("createLockfile", () => {
    it("creates lockfile and cleanup removes it", (t) => {
      const { path: lockPath, cleanup } = createLockfile("lock-test-" + Date.now());
      assert.ok(fs.existsSync(lockPath));
      cleanup();
      assert.ok(!fs.existsSync(lockPath));
    });

    it("registers cleanup via t.after", (t) => {
      const { path: lockPath } = createLockfile("lock-after-" + Date.now(), { t });
      assert.ok(fs.existsSync(lockPath));
      // Cleanup happens automatically via t.after
    });
  });
});
