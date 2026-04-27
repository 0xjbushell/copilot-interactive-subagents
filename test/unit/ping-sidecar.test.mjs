import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { importProjectModule } from "../helpers/red-harness.mjs";

const MODULE_PATH = "packages/copilot-interactive-subagents/extension/lib/ping-sidecar.mjs";

async function loadModule() {
  return importProjectModule(MODULE_PATH, [
    "appendPing",
    "readPingsSince",
    "PING_SIDECAR_DIRNAME",
  ]);
}

function createTmpStateDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ping-sidecar-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("ping-sidecar", () => {
  describe("appendPing", () => {
    it("creates pings dir and file lazily on first append", async (t) => {
      const { appendPing } = await loadModule();
      const stateDir = createTmpStateDir(t);
      const launchId = "lch_test-001";

      const result = await appendPing({ stateDir, launchId, message: "hello" });

      assert.ok(result.writtenAt, "writtenAt should be set");
      assert.equal(typeof result.cursor, "number");

      const filePath = path.join(stateDir, "pings", `${launchId}.jsonl`);
      assert.ok(fs.existsSync(filePath), "pings.jsonl should exist");

      const content = fs.readFileSync(filePath, "utf8");
      assert.ok(content.endsWith("\n"), "record should be terminated by newline");

      const record = JSON.parse(content.trim());
      assert.equal(record.version, 1);
      assert.equal(record.type, "message");
      assert.equal(record.launchId, launchId);
      assert.equal(record.message, "hello");
      assert.ok(record.writtenAt);
    });

    it("appends multiple records as separate lines", async (t) => {
      const { appendPing } = await loadModule();
      const stateDir = createTmpStateDir(t);
      const launchId = "lch_multi";

      await appendPing({ stateDir, launchId, message: "first" });
      await appendPing({ stateDir, launchId, message: "second" });

      const filePath = path.join(stateDir, "pings", `${launchId}.jsonl`);
      const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]).message, "first");
      assert.equal(JSON.parse(lines[1]).message, "second");
    });

    it("uses injected now() for writtenAt", async (t) => {
      const { appendPing } = await loadModule();
      const stateDir = createTmpStateDir(t);
      const fixedTime = "2026-04-26T12:00:00.000Z";

      const result = await appendPing({
        stateDir,
        launchId: "lch_time",
        message: "timed",
        services: { now: () => fixedTime },
      });

      assert.equal(result.writtenAt, fixedTime);
      const filePath = path.join(stateDir, "pings", "lch_time.jsonl");
      const record = JSON.parse(fs.readFileSync(filePath, "utf8").trim());
      assert.equal(record.writtenAt, fixedTime);
    });

    it("returns cursor equal to the byte size after the write", async (t) => {
      const { appendPing } = await loadModule();
      const stateDir = createTmpStateDir(t);
      const launchId = "lch_cursor";

      const r1 = await appendPing({ stateDir, launchId, message: "a" });
      const filePath = path.join(stateDir, "pings", `${launchId}.jsonl`);
      const sizeAfterFirst = fs.statSync(filePath).size;
      assert.equal(r1.cursor, sizeAfterFirst);

      const r2 = await appendPing({ stateDir, launchId, message: "b" });
      const sizeAfterSecond = fs.statSync(filePath).size;
      assert.equal(r2.cursor, sizeAfterSecond);
    });
  });

  describe("readPingsSince", () => {
    it("returns all records when sinceCursor is 0", async (t) => {
      const { appendPing, readPingsSince } = await loadModule();
      const stateDir = createTmpStateDir(t);
      const launchId = "lch_read-all";

      await appendPing({ stateDir, launchId, message: "one" });
      await appendPing({ stateDir, launchId, message: "two" });

      const result = await readPingsSince({ stateDir, launchId, sinceCursor: 0 });

      assert.equal(result.records.length, 2);
      assert.equal(result.records[0].message, "one");
      assert.equal(result.records[1].message, "two");
      assert.equal(result.hasMore, false);

      const filePath = path.join(stateDir, "pings", `${launchId}.jsonl`);
      assert.equal(result.nextCursor, fs.statSync(filePath).size);
    });

    it("returns only records after sinceCursor", async (t) => {
      const { appendPing, readPingsSince } = await loadModule();
      const stateDir = createTmpStateDir(t);
      const launchId = "lch_read-partial";

      const r1 = await appendPing({ stateDir, launchId, message: "before" });
      await appendPing({ stateDir, launchId, message: "after" });

      const result = await readPingsSince({ stateDir, launchId, sinceCursor: r1.cursor });

      assert.equal(result.records.length, 1);
      assert.equal(result.records[0].message, "after");
      assert.equal(result.hasMore, false);
    });

    it("returns empty when file does not exist", async (t) => {
      const { readPingsSince } = await loadModule();
      const stateDir = createTmpStateDir(t);

      const result = await readPingsSince({ stateDir, launchId: "lch_missing", sinceCursor: 0 });

      assert.deepEqual(result.records, []);
      assert.equal(result.nextCursor, 0);
      assert.equal(result.hasMore, false);
    });

    it("returns empty when file exists but is 0 bytes", async (t) => {
      const { readPingsSince } = await loadModule();
      const stateDir = createTmpStateDir(t);
      const launchId = "lch_empty";
      const pingsDir = path.join(stateDir, "pings");
      fs.mkdirSync(pingsDir, { recursive: true });
      fs.writeFileSync(path.join(pingsDir, `${launchId}.jsonl`), "");

      const result = await readPingsSince({ stateDir, launchId, sinceCursor: 0 });

      assert.deepEqual(result.records, []);
      assert.equal(result.nextCursor, 0);
      assert.equal(result.hasMore, false);
    });

    it("tolerates partial trailing line", async (t) => {
      const { appendPing, readPingsSince } = await loadModule();
      const stateDir = createTmpStateDir(t);
      const launchId = "lch_partial";

      await appendPing({ stateDir, launchId, message: "complete" });

      // Simulate a partial write by appending incomplete JSON
      const filePath = path.join(stateDir, "pings", `${launchId}.jsonl`);
      fs.appendFileSync(filePath, '{"version":1,"type":"message","launchId":"lch_partial","mes');

      const result = await readPingsSince({ stateDir, launchId, sinceCursor: 0 });

      assert.equal(result.records.length, 1);
      assert.equal(result.records[0].message, "complete");
      assert.equal(result.hasMore, true);
    });

    it("skips records with version > 1 and warns", async (t) => {
      const { readPingsSince } = await loadModule();
      const stateDir = createTmpStateDir(t);
      const launchId = "lch_fwd-compat";
      const pingsDir = path.join(stateDir, "pings");
      fs.mkdirSync(pingsDir, { recursive: true });

      const v1Record = JSON.stringify({ version: 1, type: "message", launchId, message: "v1", writtenAt: "2026-01-01T00:00:00Z" });
      const v2Record = JSON.stringify({ version: 2, type: "message", launchId, message: "v2", writtenAt: "2026-01-01T00:00:01Z" });
      const v1Record2 = JSON.stringify({ version: 1, type: "message", launchId, message: "v1-again", writtenAt: "2026-01-01T00:00:02Z" });
      fs.writeFileSync(path.join(pingsDir, `${launchId}.jsonl`), `${v1Record}\n${v2Record}\n${v1Record2}\n`);

      const warnings = [];
      const result = await readPingsSince({
        stateDir,
        launchId,
        sinceCursor: 0,
        services: { warn: (msg) => warnings.push(msg) },
      });

      assert.equal(result.records.length, 2);
      assert.equal(result.records[0].message, "v1");
      assert.equal(result.records[1].message, "v1-again");
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes("version"));
    });

    it("returns empty when sinceCursor is beyond file size", async (t) => {
      const { appendPing, readPingsSince } = await loadModule();
      const stateDir = createTmpStateDir(t);
      const launchId = "lch_beyond";

      await appendPing({ stateDir, launchId, message: "data" });

      const result = await readPingsSince({ stateDir, launchId, sinceCursor: 999999 });

      assert.deepEqual(result.records, []);
      assert.equal(result.nextCursor, 999999);
      assert.equal(result.hasMore, false);
    });

    it("includes cursor on each returned record", async (t) => {
      const { appendPing, readPingsSince } = await loadModule();
      const stateDir = createTmpStateDir(t);
      const launchId = "lch_rec-cursor";

      await appendPing({ stateDir, launchId, message: "first" });
      await appendPing({ stateDir, launchId, message: "second" });

      const result = await readPingsSince({ stateDir, launchId, sinceCursor: 0 });

      assert.equal(result.records.length, 2);
      assert.equal(typeof result.records[0].cursor, "number");
      assert.equal(typeof result.records[1].cursor, "number");
      assert.ok(result.records[0].cursor < result.records[1].cursor);
      assert.equal(result.records[1].cursor, result.nextCursor);
    });
  });
});
