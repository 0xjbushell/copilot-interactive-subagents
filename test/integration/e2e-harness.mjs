import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Create an isolated E2E environment with real filesystem but controlled state directory.
 */
export async function createE2EContext() {
  const testId = randomUUID().slice(0, 8);
  const stateDir = await mkdtemp(join(tmpdir(), `e2e-subagents-${testId}-`));
  const launchesDir = join(stateDir, "launches");
  const locksDir = join(stateDir, "locks");
  const doneDir = join(stateDir, "done");
  await mkdir(launchesDir, { recursive: true });
  await mkdir(locksDir, { recursive: true });
  await mkdir(doneDir, { recursive: true });

  return {
    testId,
    stateDir,
    launchesDir,
    cleanup: async () => {
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

/**
 * Read all manifests from the state directory.
 */
export async function readAllManifests(launchesDir) {
  const files = await readdir(launchesDir);
  const manifests = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const content = await readFile(join(launchesDir, file), "utf8");
    manifests.push(JSON.parse(content));
  }
  return manifests;
}

/**
 * Read a specific manifest by launchId.
 */
export async function readManifest(launchesDir, launchId) {
  const content = await readFile(join(launchesDir, `${launchId}.json`), "utf8");
  return JSON.parse(content);
}

/**
 * Write a signal file (simulating subagent_done).
 */
export async function writeTestSignalFile(stateDir, copilotSessionId, launchId) {
  const doneDir = join(stateDir, "done");
  await mkdir(doneDir, { recursive: true });
  const content = `${new Date().toISOString()}|${launchId}`;
  await writeFile(join(doneDir, copilotSessionId), content, "utf8");
}
