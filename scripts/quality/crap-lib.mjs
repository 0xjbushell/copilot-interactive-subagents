export function normalizeCoverage(coverage) {
  if (coverage <= 1) {
    return coverage;
  }

  return coverage / 100;
}

export function calculateCrapScore({ complexity, coverage }) {
  const normalizedCoverage = normalizeCoverage(coverage);
  const uncovered = 1 - normalizedCoverage;
  const score = complexity ** 2 * uncovered ** 3 + complexity;
  return Number(score.toFixed(3));
}

export function evaluateCrapEntries(entries, { threshold = 8 } = {}) {
  const evaluatedEntries = entries.map((entry) => {
    const score = calculateCrapScore(entry);
    return {
      ...entry,
      score,
      coveragePercent: Number((normalizeCoverage(entry.coverage) * 100).toFixed(1)),
      status: score > threshold ? "fail" : "ok",
    };
  });

  return {
    threshold,
    entries: evaluatedEntries,
    failing: evaluatedEntries.filter((entry) => entry.status === "fail"),
    ok: evaluatedEntries.every((entry) => entry.status === "ok"),
  };
}

export function buildCrapEntries({
  targets,
  coverage,
  analyzeModule,
  readSource,
  resolvePath,
}) {
  const entries = [];

  for (const target of targets) {
    const absolute = resolvePath(target);
    const coverageEntry = coverage[absolute];

    if (!coverageEntry) {
      throw new Error(`No coverage data found for ${target}. Ensure tests execute this file before running CRAP evaluation.`);
    }

    const moduleReport = analyzeModule(readSource(target));

    for (const method of moduleReport.methods) {
      if (method.name.startsWith("<anon")) {
        continue;
      }

      const fnEntry = Object.entries(coverageEntry.fnMap).find(
        ([, meta]) => meta.name === method.name && meta.line === method.lineStart,
      );
      const hitCount = fnEntry ? coverageEntry.f[fnEntry[0]] : 0;

      entries.push({
        name: `${target}:${method.name}`,
        complexity: method.cyclomatic,
        coverage: hitCount > 0 ? 100 : 0,
      });
    }
  }

  return entries;
}

export function formatCrapReport(report) {
  const lines = [
    `CRAP Score Report (threshold: ${report.threshold})`,
    "──────────────────────────────────────────────────────────────",
    "Function                        Comp   Cov%   CRAP  Status",
    "──────────────────────────────────────────────────────────────",
  ];

  for (const entry of report.entries) {
    const status = entry.status === "ok" ? "✓ OK" : "✗ FAIL (>8)";
    lines.push(
      `${entry.name.padEnd(30).slice(0, 30)} ${String(entry.complexity).padStart(5)} ${entry.coveragePercent
        .toFixed(1)
        .padStart(6)} ${String(entry.score).padStart(6)}  ${status}`,
    );
  }

  lines.push("──────────────────────────────────────────────────────────────");
  if (report.ok) {
    lines.push(`✓ All ${report.entries.length} functions below CRAP ${report.threshold}`);
  } else {
    lines.push(`✗ ${report.failing.length}/${report.entries.length} functions exceed CRAP ${report.threshold}`);
  }

  return lines.join("\n");
}
