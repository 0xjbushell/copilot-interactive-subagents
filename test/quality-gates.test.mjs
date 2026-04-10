import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildCrapEntries,
  calculateCrapScore,
  evaluateCrapEntries,
} from "../scripts/quality/crap-lib.mjs";
import {
  runMutationPlan,
  scoreMutationResults,
  summarizeMutationResults,
} from "../scripts/quality/mutation-lib.mjs";
import { buildCrapRunPlan } from "../scripts/test-crap.mjs";
import { buildMutationRunPlan } from "../scripts/test-mutation.mjs";
import { resolveQualityTargetSet } from "../scripts/quality/targets.mjs";

describe("quality gate helpers", () => {
  it("calculates CRAP scores from either coverage ratios or percentages", () => {
    assert.equal(calculateCrapScore({ complexity: 3, coverage: 1 }), 3);
    assert.equal(calculateCrapScore({ complexity: 3, coverage: 100 }), 3);
    assert.equal(calculateCrapScore({ complexity: 5, coverage: 50 }), 8.125);
  });

  it("evaluates CRAP entries against a threshold", () => {
    const report = evaluateCrapEntries(
      [
        { name: "safe", complexity: 2, coverage: 100 },
        { name: "risky", complexity: 5, coverage: 50 },
      ],
      { threshold: 5 },
    );

    assert.equal(report.ok, false);
    assert.equal(report.failing.length, 1);
    assert.equal(report.failing[0].name, "risky");
    assert.equal(report.entries[0].status, "ok");
    assert.equal(report.entries[1].status, "fail");
  });

  it("scores mutation results against a required threshold", () => {
    const result = scoreMutationResults(
      [
        { id: "m1", status: "killed" },
        { id: "m2", status: "killed" },
        { id: "m3", status: "survived" },
      ],
      { threshold: 80 },
    );

    assert.equal(result.killed, 2);
    assert.equal(result.total, 3);
    assert.equal(result.score, 66.67);
    assert.equal(result.ok, false);
  });

  it("summarizes mutation results with killed and survived counts", () => {
    const summary = summarizeMutationResults([
      { id: "m1", status: "killed" },
      { id: "m2", status: "survived" },
    ]);

    assert.match(summary, /m1: KILLED/);
    assert.match(summary, /m2: SURVIVED/);
    assert.match(summary, /Mutation score: 50.0% \(1\/2 killed\)/);
  });

  it("fails CRAP entry building when coverage data is missing for a target", () => {
    assert.throws(
      () =>
        buildCrapEntries({
          targets: ["lib/example.mjs"],
          coverage: {},
          analyzeModule: () => ({
            methods: [{ name: "example", lineStart: 1, cyclomatic: 1 }],
          }),
          readSource: () => "export function example() {}",
          resolvePath: (value) => value,
        }),
      /No coverage data found for lib\/example\.mjs/,
    );
  });

  it("restores mutated files even when the test runner throws", async () => {
    const files = new Map([["file.mjs", "const flag = true;\n"]]);

    await assert.rejects(
      () =>
        runMutationPlan(
          [
            {
              id: "flag-mutant",
              file: "file.mjs",
              from: "true",
              to: "false",
            },
          ],
          {
            readFile: async (file) => files.get(file),
            writeFile: async (file, contents) => files.set(file, contents),
            runTest: async () => {
              throw new Error("boom");
            },
          },
        ),
      /boom/,
    );

    assert.equal(files.get("file.mjs"), "const flag = true;\n");
  });

  it("provides the pre-mutation source to mutation lifecycle hooks", async () => {
    const files = new Map([["file.mjs", "const flag = true;\n"]]);
    let observedOriginal = null;

    const results = await runMutationPlan(
      [
        {
          id: "flag-mutant",
          file: "file.mjs",
          from: "true",
          to: "false",
        },
      ],
      {
        readFile: async (file) => files.get(file),
        writeFile: async (file, contents) => files.set(file, contents),
        runTest: async () => {},
        onMutationApplied: ({ original }) => {
          observedOriginal = original;
        },
      },
    );

    assert.equal(observedOriginal, "const flag = true;\n");
    assert.equal(results[0].status, "survived");
  });

  it("resolves the committed resume quality-gate scope for reproducible slice-local validation", () => {
    const scope = resolveQualityTargetSet("resume");

    assert.equal(scope.testPattern, "test/resume.test.mjs");
    assert.deepEqual(scope.crapTargets, [
      ".github/extensions/copilot-interactive-subagents/lib/resume.mjs",
      ".github/extensions/copilot-interactive-subagents/lib/state-index.mjs",
    ]);
    assert.ok(scope.mutationTargets.some((mutant) => mutant.id === "resume-workspace-priority"));
    assert.ok(scope.mutationTargets.some((mutant) => mutant.id === "state-index-lookup-entry"));
  });

  it("rejects unknown quality-gate scopes", () => {
    assert.throws(() => resolveQualityTargetSet("missing-scope"), /Unknown quality target scope/);
  });

  it("builds the shipped default CRAP command plan from the committed default scope", () => {
    const plan = buildCrapRunPlan();

    assert.equal(plan.scope, "default");
    assert.equal(plan.testPattern, "test/*.test.mjs test/unit/*.test.mjs");
    assert.deepEqual(plan.coverageCommand, [
      "npx",
      "c8",
      "--reporter=json",
      "node",
      "--test",
      "test/*.test.mjs test/unit/*.test.mjs",
    ]);
    assert.ok(plan.crapTargets.includes(".github/extensions/copilot-interactive-subagents/extension.mjs"));
    assert.ok(plan.crapTargets.includes(".github/extensions/copilot-interactive-subagents/lib/titles.mjs"));
  });

  it("builds the shipped default mutation command plan from the committed default scope", () => {
    const plan = buildMutationRunPlan();

    assert.equal(plan.scope, "default");
    assert.deepEqual(plan.testCommand, ["node", "--test", "test/*.test.mjs test/unit/*.test.mjs"]);
    assert.ok(plan.mutationTargets.some((mutant) => mutant.id === "extension-normalize-request"));
    assert.ok(plan.mutationTargets.some((mutant) => mutant.id === "titles-unsupported-backend"));
  });
});
