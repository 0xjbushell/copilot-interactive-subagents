#!/usr/bin/env node

import { cp, mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIRECTORY = path.dirname(SCRIPT_PATH);

export const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
export const EXTENSION_NAME = "copilot-interactive-subagents";
export const SKILL_NAME = "using-copilot-interactive-subagents";

function defaultGlobalRoot() {
  return process.env.COPILOT_INSTALL_GLOBAL_ROOT ?? path.join(os.homedir(), ".copilot");
}

function usage() {
  return `Install the copilot-interactive-subagents extension and skill.

Usage:
  node scripts/install.mjs [options]

Options:
  --scope <global|project>   Install into ~/.copilot or a target project.
  --project-root <path>      Target repository root for project installs.
  --global-root <path>       Override the user-level Copilot root (default: ~/.copilot).
  --force                    Overwrite an existing install.
  --help                     Show this message.
`;
}

function parseArgs(argv) {
  const options = {
    force: false,
    globalRoot: defaultGlobalRoot(),
    projectRoot: null,
    scope: null,
  };
  const valueHandlers = {
    "--global-root": (value) => {
      options.globalRoot = value;
    },
    "--project-root": (value) => {
      options.projectRoot = value;
    },
    "--scope": (value) => {
      if (value !== "global" && value !== "project") {
        throw new Error(`Unsupported scope "${value}". Use "global" or "project".`);
      }

      options.scope = value;
    },
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }

    if (argument === "--force") {
      options.force = true;
      continue;
    }

    const valueHandler = valueHandlers[argument];

    if (!valueHandler) {
      throw new Error(`Unknown argument: ${argument}`);
    }

    const value = argv[index + 1];

    if (!value) {
      throw new Error(`Missing value for ${argument}.`);
    }

    valueHandler(value);
    index += 1;
  }

  return options;
}

export function parseScopeAnswer(rawAnswer) {
  const answer = rawAnswer.trim().toLowerCase();

  if (answer === "" || answer === "g" || answer === "global") {
    return "global";
  }

  if (answer === "p" || answer === "project") {
    return "project";
  }

  throw new Error("Unrecognized scope selection. Enter global, g, project, or p.");
}

function assertInteractiveTerminal() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Missing --scope. In non-interactive mode, pass --scope global or --scope project.");
  }
}

async function askQuestion(promptText) {
  const interfaceHandle = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    return await interfaceHandle.question(promptText);
  } finally {
    interfaceHandle.close();
  }
}

async function selectScopeInteractively() {
  assertInteractiveTerminal();
  return parseScopeAnswer(
    await askQuestion("Install scope ([g]lobal/[p]roject, default: global): ")
  );
}

function resolveInstallTargets({ globalRoot, projectRoot, scope }) {
  const resolvedGlobalRoot = path.resolve(globalRoot);
  const resolvedProjectRoot = projectRoot ? path.resolve(projectRoot) : process.cwd();
  const installRoot =
    scope === "global"
      ? resolvedGlobalRoot
      : path.join(resolvedProjectRoot, ".github");

  return {
    extension: {
      destinationPath: path.join(installRoot, "extensions", EXTENSION_NAME),
      sourcePath: path.join(PROJECT_ROOT, "packages", EXTENSION_NAME, "extension"),
    },
    installRoot:
      scope === "global"
        ? resolvedGlobalRoot
        : resolvedProjectRoot,
    scope,
    skill: {
      destinationPath: path.join(installRoot, "skills", SKILL_NAME),
      sourcePath: path.join(PROJECT_ROOT, "packages", EXTENSION_NAME, "skill"),
    },
  };
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function isSelfInstall(sourcePath, destinationPath) {
  return path.resolve(sourcePath) === path.resolve(destinationPath);
}

async function assertInstallable(request, force) {
  if (!(await pathExists(request.sourcePath))) {
    throw new Error(`${request.label} source is missing at ${request.sourcePath}.`);
  }

  if (isSelfInstall(request.sourcePath, request.destinationPath)) {
    return;
  }

  if (await pathExists(request.destinationPath) && !force) {
    throw new Error(
      `${request.label} already exists at ${request.destinationPath}. Re-run with --force to overwrite it.`,
    );
  }
}

async function installDirectory({ destinationPath, force, label, sourcePath }) {
  if (isSelfInstall(sourcePath, destinationPath)) {
    return {
      action: "skipped",
      destinationPath,
      label,
      reason: "already present at the destination path",
    };
  }

  if (await pathExists(destinationPath)) {
    if (!force) {
      throw new Error(`${label} already exists at ${destinationPath}. Re-run with --force to overwrite it.`);
    }

    await rm(destinationPath, { recursive: true, force: true });
  }

  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath, {
    force: false,
    recursive: true,
  });

  return {
    action: "installed",
    destinationPath,
    label,
  };
}

export async function installAssets(rawOptions = {}) {
  const options = {
    force: Boolean(rawOptions.force),
    globalRoot: rawOptions.globalRoot ?? defaultGlobalRoot(),
    projectRoot: rawOptions.projectRoot ?? null,
    scope: rawOptions.scope ?? null,
  };
  const scope = options.scope ?? (await selectScopeInteractively());
  const targets = resolveInstallTargets({
    globalRoot: options.globalRoot,
    projectRoot: options.projectRoot,
    scope,
  });
  const installRequests = [
    {
      destinationPath: targets.extension.destinationPath,
      force: options.force,
      label: "Extension",
      sourcePath: targets.extension.sourcePath,
    },
    {
      destinationPath: targets.skill.destinationPath,
      force: options.force,
      label: "Skill",
      sourcePath: targets.skill.sourcePath,
    },
  ];

  for (const request of installRequests) {
    await assertInstallable(request, options.force);
  }

  const results = [];

  for (const request of installRequests) {
    results.push(await installDirectory(request));
  }

  return {
    installRoot: targets.installRoot,
    results,
    scope,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);

  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }

  const result = await installAssets(options);

  process.stdout.write(
    [
      `Installed scope: ${result.scope}`,
      `Install root: ${result.installRoot}`,
      ...result.results.map(({ action, destinationPath, label, reason }) =>
        action === "installed"
          ? `${label}: installed to ${destinationPath}`
          : `${label}: skipped (${reason})`,
      ),
      "Restart Copilot CLI to pick up the new extension and skill.",
    ].join("\n") + "\n",
  );

  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const exitCode = await main();
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
