export function scoreMutationResults(results, { threshold = 80 } = {}) {
  const total = results.length;
  const killed = results.filter((result) => result.status === "killed").length;
  const score = total === 0 ? 0 : Number(((killed / total) * 100).toFixed(2));

  return {
    threshold,
    total,
    killed,
    score,
    ok: score >= threshold,
  };
}

export function summarizeMutationResults(results, { threshold = 80 } = {}) {
  const lines = results.map(
    (result) => `${result.id}: ${result.status === "killed" ? "KILLED" : "SURVIVED"}`,
  );
  const summary = scoreMutationResults(results, { threshold });
  lines.push(`Mutation score: ${summary.score.toFixed(1)}% (${summary.killed}/${summary.total} killed)`);
  return lines.join("\n");
}

export async function runMutationPlan(
  mutants,
  { readFile, writeFile, runTest, onMutationApplied, onMutationRestored },
) {
  const results = [];

  for (const mutant of mutants) {
    const original = await readFile(mutant.file);

    if (!original.includes(mutant.from)) {
      throw new Error(`Mutation snippet not found for ${mutant.id}`);
    }

    await onMutationApplied?.({ mutant, original });
    await writeFile(mutant.file, original.replace(mutant.from, mutant.to));

    try {
      await runTest(mutant);
      results.push({ id: mutant.id, status: "survived" });
    } catch (error) {
      results.push({ id: mutant.id, status: "killed" });

      if (error?.message !== "mutation-killed") {
        throw error;
      }
    } finally {
      await writeFile(mutant.file, original);
      await onMutationRestored?.({ mutant, original });
    }
  }

  return results;
}
