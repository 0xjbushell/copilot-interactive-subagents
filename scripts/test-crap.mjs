import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import escomplex from "typhonjs-escomplex";

import { buildCrapEntries, evaluateCrapEntries, formatCrapReport } from "./quality/crap-lib.mjs";
import { resolveQualityTargetSet } from "./quality/targets.mjs";

export function buildCrapRunPlan(scope = "default") {
  const targetSet = resolveQualityTargetSet(scope);

  return {
    scope,
    testPattern: targetSet.testPattern,
    crapTargets: [...targetSet.crapTargets],
    coverageCommand: ["npx", "c8", "--reporter=json", "node", "--test", targetSet.testPattern],
  };
}

export function runCoverageJson(plan) {
  const [command, ...args] = plan.coverageCommand;
  const result = spawnSync(command, args, { stdio: "inherit", shell: true });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

export function loadCoverage() {
  const coveragePath = path.resolve("coverage/coverage-final.json");
  return JSON.parse(readFileSync(coveragePath, "utf8"));
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const plan = buildCrapRunPlan(process.argv[2] ?? "default");

  runCoverageJson(plan);

  const report = evaluateCrapEntries(
    buildCrapEntries({
      targets: plan.crapTargets,
      coverage: loadCoverage(),
      analyzeModule: (source) => escomplex.analyzeModule(source),
      readSource: (target) => readFileSync(target, "utf8"),
      resolvePath: (target) => path.resolve(target),
    }),
  );
  console.log(formatCrapReport(report));
  rmSync(path.resolve("coverage"), { recursive: true, force: true });

  process.exit(report.ok ? 0 : 1);
}
