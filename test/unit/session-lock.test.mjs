import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { importProjectModule } from "../helpers/red-harness.mjs";

const LOCK_PATH = ".github/extensions/copilot-interactive-subagents/lib/session-lock.mjs";

describe("Session lock", () => {
  function createMockFs() {
    const files = new Map();
    let nextFd = 10;
    return {
      files,
      openSync(filePath, flags) {
        if (files.has(filePath) && (flags & 0x80)) {
          // O_EXCL = 0x80 on Linux
          const err = new Error("EEXIST");
          err.code = "EEXIST";
          throw err;
        }
        const fd = nextFd++;
        files.set(filePath, { fd, content: "" });
        return fd;
      },
      writeFileSync(fdOrPath, content) {
        if (typeof fdOrPath === "number") {
          for (const [, v] of files) {
            if (v.fd === fdOrPath) { v.content = content; return; }
          }
        } else {
          files.set(fdOrPath, { content });
        }
      },
      readFileSync(filePath) {
        const entry = files.get(filePath);
        if (!entry) {
          const err = new Error("ENOENT");
          err.code = "ENOENT";
          throw err;
        }
        return entry.content;
      },
      unlinkSync(filePath) {
        files.delete(filePath);
      },
      mkdirSync() {},
    };
  }

  it("GIVEN no lock exists WHEN acquireLock called THEN lock acquired and release function returned", async () => {
    const { acquireLock } = await importProjectModule(LOCK_PATH, ["acquireLock"]);
    const fs = createMockFs();
    const lock = acquireLock({
      copilotSessionId: "test-session",
      stateDir: "/tmp/test",
      services: { ...fs, pid: () => 12345, now: () => 1000 },
    });
    assert.ok(typeof lock.release === "function");
    // Verify lockfile was written with pid and startedAt
    let foundContent = null;
    for (const [key, val] of fs.files) {
      if (key.includes("test-session.lock")) {
        foundContent = val.content;
      }
    }
    assert.ok(foundContent);
    const parsed = JSON.parse(foundContent);
    assert.equal(parsed.pid, 12345);
    assert.equal(parsed.startedAt, 1000);
  });

  it("GIVEN lock held WHEN second acquireLock called THEN throws SESSION_ACTIVE", async () => {
    const { acquireLock } = await importProjectModule(LOCK_PATH, ["acquireLock"]);
    const fs = createMockFs();
    const services = { ...fs, pid: () => 99, now: () => 1000, isProcessAlive: () => true };
    acquireLock({ copilotSessionId: "s1", stateDir: "/tmp/t", services });
    assert.throws(
      () => acquireLock({ copilotSessionId: "s1", stateDir: "/tmp/t", services }),
      (err) => err.code === "SESSION_ACTIVE",
    );
  });

  it("GIVEN lock released WHEN acquireLock called again THEN succeeds", async () => {
    const { acquireLock } = await importProjectModule(LOCK_PATH, ["acquireLock"]);
    const fs = createMockFs();
    const services = { ...fs, pid: () => 99, now: () => 1000, isProcessAlive: () => true };
    const lock1 = acquireLock({ copilotSessionId: "s1", stateDir: "/tmp/t", services });
    lock1.release();
    const lock2 = acquireLock({ copilotSessionId: "s1", stateDir: "/tmp/t", services });
    assert.ok(typeof lock2.release === "function");
    lock2.release();
  });

  it("GIVEN release called twice WHEN second release runs THEN no error (idempotent)", async () => {
    const { acquireLock } = await importProjectModule(LOCK_PATH, ["acquireLock"]);
    const fs = createMockFs();
    const services = { ...fs, pid: () => 99, now: () => 1000 };
    const lock = acquireLock({ copilotSessionId: "s1", stateDir: "/tmp/t", services });
    lock.release();
    lock.release(); // should not throw
  });

  it("GIVEN stale lock (owner PID dead) WHEN acquireLock called THEN recovers and acquires", async () => {
    const { acquireLock } = await importProjectModule(LOCK_PATH, ["acquireLock"]);
    const fs = createMockFs();
    // Pre-create a stale lock
    const staleLockPath = "/tmp/t/locks/s1.lock";
    fs.files.set(staleLockPath, { content: JSON.stringify({ pid: 99999, startedAt: 500 }) });

    const services = { ...fs, pid: () => 42, now: () => 2000, isProcessAlive: (pid) => pid !== 99999 };
    const lock = acquireLock({ copilotSessionId: "s1", stateDir: "/tmp/t", services });
    assert.ok(typeof lock.release === "function");
    lock.release();
  });

  it("GIVEN lock directory missing WHEN acquireLock called THEN directory created automatically", async () => {
    const { acquireLock } = await importProjectModule(LOCK_PATH, ["acquireLock"]);
    let mkdirCalled = false;
    const fs = createMockFs();
    fs.mkdirSync = (dir, opts) => { mkdirCalled = true; assert.ok(opts.recursive); };
    const services = { ...fs, pid: () => 1, now: () => 0 };
    acquireLock({ copilotSessionId: "s1", stateDir: "/tmp/t", services }).release();
    assert.ok(mkdirCalled, "mkdirSync should be called with recursive: true");
  });
});
