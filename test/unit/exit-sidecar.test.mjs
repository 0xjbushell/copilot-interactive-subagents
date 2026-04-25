import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { importProjectModule } from "../helpers/red-harness.mjs";

const MOD_PATH = "packages/copilot-interactive-subagents/extension/lib/exit-sidecar.mjs";
const EXPORTS = [
  "SIDECAR_VERSION",
  "SIDECAR_DIRNAME",
  "writeExitSidecar",
  "readExitSidecar",
  "deleteExitSidecar",
  "resolveStateDir",
];

function tmpStateDir() {
  return mkdtempSync(path.join(tmpdir(), "exit-sidecar-test-"));
}

function fixedNow() {
  return "2025-01-02T03:04:05.000Z";
}

describe("lib/exit-sidecar.mjs", () => {
  describe("constants and resolveStateDir", () => {
    it("exports SIDECAR_VERSION === 1 and SIDECAR_DIRNAME === 'exit'", async () => {
      const mod = await importProjectModule(MOD_PATH, EXPORTS);
      assert.equal(mod.SIDECAR_VERSION, 1);
      assert.equal(mod.SIDECAR_DIRNAME, "exit");
    });

    it("resolveStateDir({projectRoot:'/foo'}) returns '/foo/.copilot-interactive-subagents'", async () => {
      const { resolveStateDir } = await importProjectModule(MOD_PATH, EXPORTS);
      assert.equal(resolveStateDir({ projectRoot: "/foo" }), "/foo/.copilot-interactive-subagents");
    });

    it("resolveStateDir() defaults projectRoot to process.cwd()", async () => {
      const { resolveStateDir } = await importProjectModule(MOD_PATH, EXPORTS);
      assert.equal(resolveStateDir(), path.resolve(process.cwd(), ".copilot-interactive-subagents"));
    });

    it("resolveStateDir({}) (empty object) defaults projectRoot to process.cwd()", async () => {
      const { resolveStateDir } = await importProjectModule(MOD_PATH, EXPORTS);
      assert.equal(resolveStateDir({}), path.resolve(process.cwd(), ".copilot-interactive-subagents"));
    });
  });

  describe("writeExitSidecar", () => {
    it("AC1: writes done sidecar with exit code", async () => {
      const { writeExitSidecar } = await importProjectModule(MOD_PATH, EXPORTS);
      const stateDir = tmpStateDir();
      try {
        writeExitSidecar({
          launchId: "L1",
          type: "done",
          summary: "x",
          exitCode: 0,
          stateDir,
          services: { now: fixedNow },
        });
        const filePath = path.join(stateDir, "exit", "L1.json");
        assert.ok(existsSync(filePath), "sidecar file should exist");
        const parsed = JSON.parse(readFileSync(filePath, "utf8"));
        assert.deepEqual(parsed, {
          version: 1,
          type: "done",
          writtenAt: "2025-01-02T03:04:05.000Z",
          launchId: "L1",
          summary: "x",
          exitCode: 0,
        });
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("AC2: writes ping sidecar with no summary/exitCode fields", async () => {
      const { writeExitSidecar } = await importProjectModule(MOD_PATH, EXPORTS);
      const stateDir = tmpStateDir();
      try {
        writeExitSidecar({
          launchId: "L2",
          type: "ping",
          message: "need help",
          stateDir,
          services: { now: fixedNow },
        });
        const parsed = JSON.parse(readFileSync(path.join(stateDir, "exit", "L2.json"), "utf8"));
        assert.equal(parsed.type, "ping");
        assert.equal(parsed.message, "need help");
        assert.ok(!("summary" in parsed), "ping sidecar should not have summary");
        assert.ok(!("exitCode" in parsed), "ping sidecar should not have exitCode");
        assert.equal(parsed.version, 1);
        assert.equal(parsed.launchId, "L2");
        assert.equal(parsed.writtenAt, "2025-01-02T03:04:05.000Z");
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("AC7 (DI): uses injected services.writeFileSync", async () => {
      const { writeExitSidecar } = await importProjectModule(MOD_PATH, EXPORTS);
      const writes = [];
      const dirs = [];
      writeExitSidecar({
        launchId: "L3",
        type: "done",
        summary: "y",
        exitCode: 1,
        stateDir: "/no/such/dir",
        services: {
          writeFileSync: (p, c) => writes.push({ p, c }),
          mkdirSync: (p, opts) => dirs.push({ p, opts }),
          renameSync: () => {},
          now: fixedNow,
        },
      });
      assert.ok(writes.length >= 1, "writeFileSync injected should be called");
      assert.ok(dirs.some((d) => d.opts?.recursive === true), "mkdir should be recursive");
    });

    it("AC8: creates exit dir on demand", async () => {
      const { writeExitSidecar } = await importProjectModule(MOD_PATH, EXPORTS);
      const stateDir = tmpStateDir();
      try {
        writeExitSidecar({
          launchId: "L4",
          type: "done",
          summary: "z",
          exitCode: 0,
          stateDir,
        });
        assert.ok(existsSync(path.join(stateDir, "exit")));
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("Adversarial: concurrent overwrite — last write wins", async () => {
      const { writeExitSidecar, readExitSidecar } = await importProjectModule(MOD_PATH, EXPORTS);
      const stateDir = tmpStateDir();
      try {
        writeExitSidecar({ launchId: "L5", type: "done", summary: "first", exitCode: 0, stateDir });
        writeExitSidecar({ launchId: "L5", type: "ping", message: "second", stateDir });
        const r = readExitSidecar({ launchId: "L5", stateDir });
        assert.equal(r.type, "ping");
        assert.equal(r.message, "second");
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("Adversarial: stateDir with spaces and unicode survives round-trip", async () => {
      const { writeExitSidecar, readExitSidecar } = await importProjectModule(MOD_PATH, EXPORTS);
      const base = mkdtempSync(path.join(tmpdir(), "esc test ünïcødé-"));
      try {
        writeExitSidecar({ launchId: "L6", type: "done", summary: "ok", exitCode: 0, stateDir: base });
        const r = readExitSidecar({ launchId: "L6", stateDir: base });
        assert.equal(r.summary, "ok");
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it("Adversarial: read-only exit dir → throws (do not swallow)", async () => {
      const { writeExitSidecar } = await importProjectModule(MOD_PATH, EXPORTS);
      assert.throws(() => {
        writeExitSidecar({
          launchId: "L7",
          type: "done",
          summary: "x",
          exitCode: 0,
          stateDir: "/tmp",
          services: {
            mkdirSync: () => {},
            writeFileSync: () => { const e = new Error("EACCES"); e.code = "EACCES"; throw e; },
            renameSync: () => { const e = new Error("EACCES"); e.code = "EACCES"; throw e; },
            now: fixedNow,
          },
        });
      });
    });
  });

  describe("readExitSidecar", () => {
    it("AC3: returns null when no sidecar exists", async () => {
      const { readExitSidecar } = await importProjectModule(MOD_PATH, EXPORTS);
      const stateDir = tmpStateDir();
      try {
        assert.equal(readExitSidecar({ launchId: "missing", stateDir }), null);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("AC4: returns null + warns on malformed JSON, does not throw", async () => {
      const { readExitSidecar, writeExitSidecar } = await importProjectModule(MOD_PATH, EXPORTS);
      const stateDir = tmpStateDir();
      try {
        // Create a valid one then clobber with junk
        writeExitSidecar({ launchId: "Lbad", type: "done", summary: "x", exitCode: 0, stateDir });
        const filePath = path.join(stateDir, "exit", "Lbad.json");
        // Write junk via plain fs (not the module)
        const fs = await import("node:fs");
        fs.writeFileSync(filePath, "{ not valid json");

        const warnings = [];
        const result = readExitSidecar({
          launchId: "Lbad",
          stateDir,
          services: { warn: (msg) => warnings.push(msg) },
        });
        assert.equal(result, null);
        assert.equal(warnings.length, 1);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("AC5: returns null + warns when version !== 1", async () => {
      const { readExitSidecar } = await importProjectModule(MOD_PATH, EXPORTS);
      const stateDir = tmpStateDir();
      try {
        const fs = await import("node:fs");
        fs.mkdirSync(path.join(stateDir, "exit"), { recursive: true });
        fs.writeFileSync(
          path.join(stateDir, "exit", "Lv2.json"),
          JSON.stringify({ version: 2, type: "done", writtenAt: "x", launchId: "Lv2" }),
        );
        const warnings = [];
        const r = readExitSidecar({ launchId: "Lv2", stateDir, services: { warn: (m) => warnings.push(m) } });
        assert.equal(r, null);
        assert.equal(warnings.length, 1);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("AC5: returns null + warns when type not in {done,ping}", async () => {
      const { readExitSidecar } = await importProjectModule(MOD_PATH, EXPORTS);
      const stateDir = tmpStateDir();
      try {
        const fs = await import("node:fs");
        fs.mkdirSync(path.join(stateDir, "exit"), { recursive: true });
        fs.writeFileSync(
          path.join(stateDir, "exit", "Lbt.json"),
          JSON.stringify({ version: 1, type: "wat", writtenAt: "x", launchId: "Lbt" }),
        );
        const warnings = [];
        const r = readExitSidecar({ launchId: "Lbt", stateDir, services: { warn: (m) => warnings.push(m) } });
        assert.equal(r, null);
        assert.ok(warnings.length >= 1);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("AC5: returns null when launchId is empty string", async () => {
      const { readExitSidecar } = await importProjectModule(MOD_PATH, EXPORTS);
      const stateDir = tmpStateDir();
      try {
        const fs = await import("node:fs");
        fs.mkdirSync(path.join(stateDir, "exit"), { recursive: true });
        fs.writeFileSync(
          path.join(stateDir, "exit", "Lel.json"),
          JSON.stringify({ version: 1, type: "done", writtenAt: "x", launchId: "" }),
        );
        const r = readExitSidecar({ launchId: "Lel", stateDir, services: { warn: () => {} } });
        assert.equal(r, null);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("AC5: returns null when writtenAt is not a string", async () => {
      const { readExitSidecar } = await importProjectModule(MOD_PATH, EXPORTS);
      const stateDir = tmpStateDir();
      try {
        const fs = await import("node:fs");
        fs.mkdirSync(path.join(stateDir, "exit"), { recursive: true });
        fs.writeFileSync(
          path.join(stateDir, "exit", "Lwa.json"),
          JSON.stringify({ version: 1, type: "done", writtenAt: 12345, launchId: "Lwa" }),
        );
        const r = readExitSidecar({ launchId: "Lwa", stateDir, services: { warn: () => {} } });
        assert.equal(r, null);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("Adversarial: extra unknown fields preserved (not pruned)", async () => {
      const { readExitSidecar } = await importProjectModule(MOD_PATH, EXPORTS);
      const stateDir = tmpStateDir();
      try {
        const fs = await import("node:fs");
        fs.mkdirSync(path.join(stateDir, "exit"), { recursive: true });
        fs.writeFileSync(
          path.join(stateDir, "exit", "Lex.json"),
          JSON.stringify({
            version: 1, type: "done", writtenAt: "t", launchId: "Lex",
            summary: "s", exitCode: 0, future: "field",
          }),
        );
        const r = readExitSidecar({ launchId: "Lex", stateDir });
        assert.equal(r.future, "field");
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });

  describe("deleteExitSidecar", () => {
    it("AC6: deleting an existing sidecar makes subsequent read return null", async () => {
      const { writeExitSidecar, readExitSidecar, deleteExitSidecar } =
        await importProjectModule(MOD_PATH, EXPORTS);
      const stateDir = tmpStateDir();
      try {
        writeExitSidecar({ launchId: "Ld", type: "done", summary: "x", exitCode: 0, stateDir });
        assert.ok(readExitSidecar({ launchId: "Ld", stateDir }));
        deleteExitSidecar({ launchId: "Ld", stateDir });
        assert.equal(readExitSidecar({ launchId: "Ld", stateDir }), null);
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });

    it("deleting a non-existent sidecar does not throw", async () => {
      const { deleteExitSidecar } = await importProjectModule(MOD_PATH, EXPORTS);
      const stateDir = tmpStateDir();
      try {
        deleteExitSidecar({ launchId: "ghost", stateDir });
      } finally {
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  });
});
