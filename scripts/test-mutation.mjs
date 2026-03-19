import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import {
  runMutationPlan,
  scoreMutationResults,
  summarizeMutationResults,
} from "./quality/mutation-lib.mjs";
import { resolveQualityTargetSet } from "./quality/targets.mjs";

export function buildMutationRunPlan(scope = "default") {
  const targetSet = resolveQualityTargetSet(scope);

  return {
    scope,
    testPattern: targetSet.testPattern,
    mutationTargets: targetSet.mutationTargets.map((mutant) => ({ ...mutant })),
    testCommand: ["node", "--test", targetSet.testPattern],
  };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const plan = buildMutationRunPlan(process.argv[2] ?? "default");

  let currentMutation = null;
  let currentOriginal = null;

  function restoreCurrentMutation() {
    if (!currentMutation || currentOriginal === null) {
      return;
    }

    writeFileSync(currentMutation.file, currentOriginal);
    currentMutation = null;
    currentOriginal = null;
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      restoreCurrentMutation();
      process.exit(1);
    });
  }

  const results = await runMutationPlan(plan.mutationTargets, {
    readFile: async (file) => readFileSync(file, "utf8"),
    writeFile: async (file, contents) => {
      writeFileSync(file, contents);
    },
    onMutationApplied: async ({ mutant, original }) => {
      currentMutation = mutant;
      currentOriginal = original;
    },
    onMutationRestored: async () => {
      currentMutation = null;
      currentOriginal = null;
    },
    runTest: async () => {
      const [command, ...args] = plan.testCommand;
      const run = spawnSync(command, args, { stdio: "ignore", shell: true });
      if (run.status !== 0) {
        throw new Error("mutation-killed");
      }
    },
  }).finally(() => {
    restoreCurrentMutation();
  });

  console.log(summarizeMutationResults(results));

  const summary = scoreMutationResults(results);
  process.exit(summary.ok ? 0 : 1);
}
