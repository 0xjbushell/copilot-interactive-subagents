import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PROJECT_ROOT } from "./helpers/red-harness.mjs";
import { importProjectModule } from "./helpers/red-harness.mjs";

const scriptPath = path.join(PROJECT_ROOT, "scripts", "install.mjs");

async function createTempDir(t, prefix) {
  const directoryPath = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await rm(directoryPath, { recursive: true, force: true });
  });
  return directoryPath;
}

function runInstaller(args, { cwd = PROJECT_ROOT, env = {}, input } = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
    input,
  });
}

test("installs the extension and skill into the user-level Copilot directory", async (t) => {
  const globalRoot = await createTempDir(t, "copilot-interactive-subagents-global-");

  const result = runInstaller(["--scope", "global"], {
    env: {
      COPILOT_INSTALL_GLOBAL_ROOT: globalRoot,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  await stat(
    path.join(
      globalRoot,
      "extensions",
      "copilot-interactive-subagents",
      "extension.mjs",
    ),
  );
  await stat(
    path.join(
      globalRoot,
      "skills",
      "using-copilot-interactive-subagents",
      "SKILL.md",
    ),
  );
});

test("installs the extension and skill into a target project", async (t) => {
  const projectRoot = await createTempDir(t, "copilot-interactive-subagents-project-");

  const result = runInstaller([
    "--scope",
    "project",
    "--project-root",
    projectRoot,
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);

  await stat(
    path.join(
      projectRoot,
      ".github",
      "extensions",
      "copilot-interactive-subagents",
      "extension.mjs",
    ),
  );
  await stat(
    path.join(
      projectRoot,
      ".github",
      "skills",
      "using-copilot-interactive-subagents",
      "SKILL.md",
    ),
  );
});

test("accepts the documented interactive scope answers", async () => {
  const { parseScopeAnswer } = await importProjectModule("scripts/install.mjs", [
    "parseScopeAnswer",
  ]);

  assert.equal(parseScopeAnswer(""), "global");
  assert.equal(parseScopeAnswer("g"), "global");
  assert.equal(parseScopeAnswer("global"), "global");
  assert.equal(parseScopeAnswer("p"), "project");
  assert.equal(parseScopeAnswer("project"), "project");
  assert.throws(
    () => parseScopeAnswer("later"),
    /Unrecognized scope selection/,
  );
});

test("documents installer usage and global/project destinations", async () => {
  const [readme, skillsGuide] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, "README.md"), "utf8"),
    readFile(path.join(PROJECT_ROOT, "docs", "skills-integration.md"), "utf8"),
  ]);

  assert.match(readme, /node scripts\/install\.mjs/);
  assert.match(readme, /--scope global/);
  assert.match(readme, /--scope project --project-root \/path\/to\/target-repo/);
  assert.match(readme, /~\/\.copilot\/extensions\/copilot-interactive-subagents/);
  assert.match(readme, /~\/\.copilot\/skills\/using-copilot-interactive-subagents/);
  assert.match(readme, /\.github\/extensions\/copilot-interactive-subagents/);
  assert.match(readme, /\.github\/skills\/using-copilot-interactive-subagents/);
  assert.match(skillsGuide, /node scripts\/install\.mjs/);
});

test("refuses to overwrite an existing install unless --force is supplied", async (t) => {
  const globalRoot = await createTempDir(t, "copilot-interactive-subagents-existing-");
  const extensionPath = path.join(
    globalRoot,
    "extensions",
    "copilot-interactive-subagents",
  );
  const skillPath = path.join(
    globalRoot,
    "skills",
    "using-copilot-interactive-subagents",
    "SKILL.md",
  );

  await mkdir(extensionPath, { recursive: true });
  await writeFile(path.join(extensionPath, "extension.mjs"), "old extension", "utf8");

  const result = runInstaller(["--scope", "global"], {
    env: {
      COPILOT_INSTALL_GLOBAL_ROOT: globalRoot,
    },
  });

  assert.notEqual(result.status, 0, "installer should fail without --force");
  assert.match(result.stderr || result.stdout, /--force/i);
  await assert.rejects(() => stat(skillPath), /ENOENT/);
});

test("overwrites an existing install when --force is supplied", async (t) => {
  const globalRoot = await createTempDir(t, "copilot-interactive-subagents-force-");
  const extensionFilePath = path.join(
    globalRoot,
    "extensions",
    "copilot-interactive-subagents",
    "extension.mjs",
  );
  const skillFilePath = path.join(
    globalRoot,
    "skills",
    "using-copilot-interactive-subagents",
    "SKILL.md",
  );

  await mkdir(path.dirname(extensionFilePath), { recursive: true });
  await writeFile(extensionFilePath, "old extension", "utf8");
  await mkdir(path.dirname(skillFilePath), { recursive: true });
  await writeFile(skillFilePath, "old skill", "utf8");

  const result = runInstaller(["--scope", "global", "--force"], {
    env: {
      COPILOT_INSTALL_GLOBAL_ROOT: globalRoot,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const [installedExtension, installedSkill, sourceExtension, sourceSkill] = await Promise.all([
    readFile(extensionFilePath, "utf8"),
    readFile(skillFilePath, "utf8"),
    readFile(
      path.join(
        PROJECT_ROOT,
        ".github",
        "extensions",
        "copilot-interactive-subagents",
        "extension.mjs",
      ),
      "utf8",
    ),
    readFile(
      path.join(
        PROJECT_ROOT,
        ".github",
        "skills",
        "using-copilot-interactive-subagents",
        "SKILL.md",
      ),
      "utf8",
    ),
  ]);

  assert.equal(installedExtension, sourceExtension);
  assert.equal(installedSkill, sourceSkill);
});
