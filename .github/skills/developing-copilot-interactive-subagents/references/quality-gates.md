# Quality Gates — Internals & Common Failures

## The Three Gates

```bash
npm test && npm run test:crap && npm run test:mutation
```

All three are **blocking**. No deliverable is "done" until all three exit 0 in the same session.

## Mutation Runner — Critical Discovery Glob

`npm run test:mutation` discovers tests via this pattern (`scripts/quality/targets.mjs:~450`):

```
test/*.test.mjs test/unit/*.test.mjs
```

**Implication**: tests under `test/integration/` and `test/e2e/` are NOT walked by the mutation runner. If a piece of logic is exercised only by an integration test, mutants on it will survive and the gate will fail.

**Fix**: For any new logic that lives behind an integration test, also write a unit test in `test/unit/` that exercises the mutated lines. The v2 D2.5 deliverable (`resume.mjs#cleanupStalePing`) demonstrates this — it has both `test/integration/ping-resume-cycle.test.mjs` (full loop) and `test/unit/resume-ping-cleanup.test.mjs` (mutation-coverable).

## Mutant Registration

Every new module needs entries in `DETERMINISTIC_LOGIC_TARGETS`:

```js
{
  file: "lib/your-module.mjs",
  mutants: [
    { line: 42, find: "===", replace: "!==", reason: "boundary swap" },
    { line: 58, find: "return true", replace: "return false", reason: "result invert" },
    // ...one per behavioral assertion
  ],
}
```

**Rules of thumb:**
- One mutant per behavioral branch, not per syntax token
- Prefer mutants on conditions (`>`, `===`, `&&`), return values, and constants
- A surviving mutant after green tests means the test asserts a side-effect rather than the behavior — strengthen the assertion
- Don't mutate logging, tracing, or pure type guards (no behavior to validate)

## CRAP Scoring

`npm run test:crap` computes CRAP (Change Risk Anti-Patterns) per function:

```
CRAP(f) = complexity(f)² × (1 - coverage(f))³ + complexity(f)
```

Bar: **CRAP < 8** for any new function. The current codebase holds 163 functions all <8.

**Common drivers of CRAP > 8:**
- Cyclomatic complexity > 10 (refactor: extract helpers, use lookup tables)
- Coverage < 60% on non-trivial functions (add unit tests for uncovered branches)

`scripts/quality/targets.mjs` is also where CRAP exemptions and per-file thresholds live.

## Common Gate Failures and Fixes

### "Mutant survived: lib/foo.mjs:42"
The test passes when the mutated condition flips → the test isn't actually asserting the behavior.
**Fix**: add an assertion that distinguishes the mutated outcome from the original.

### "CRAP score 12.4 for function bar"
Either complexity or coverage is the culprit.
**Fix**: split the function or add tests for the missing branches. Don't raise the threshold.

### "Module not found: lib/new-module.mjs" (mutation runner)
Missing entry in `DETERMINISTIC_LOGIC_TARGETS`.
**Fix**: register the file + initial mutants.

### Tests pass locally but mutation hangs
The mutated process is waiting on a real timer or filesystem call. Inject `setTimeout`, `fs`, etc. via the `services` DI param so tests use stubs.

## Gate Sequencing

Run `npm test` first (fast feedback), then `npm run test:crap` (also fast), then `npm run test:mutation` (slowest). If `npm test` fails, no point running the others.

The `&&` chain ensures you don't proceed past a failure. Never replace with `;` to "see all failures at once" — that masks regressions.

## Maintaining Mutants Through Refactors

When you move, rename, or restructure code that a registered mutant anchored on, the mutation runner throws:

```
Error: Mutation snippet not found for <mutant-id>
```

This is a feature, not a failure — it forces you to confirm the behavioral coverage still holds after the refactor. The recipe:

1. **Find the mutant** — `grep -B1 -A5 "<mutant-id>" scripts/quality/targets.mjs`
2. **Re-anchor on a snippet unique to the new code** that preserves the original *behavioral* assertion:
   - If the mutant checked a gate variable, anchor on the new gate's condition
   - If the mutant flipped a boundary (`>` vs `>=`), re-anchor on the equivalent boundary in the new shape
   - If the mutant removed a call site, anchor on a distinguishing property of that call (e.g. tool `name` string)
3. **Prefer stronger assertions**: when collapsing multiple conditional blocks, the new mutant can often target a more specific behavior than the original (e.g. mutating a tool's `name` field proves the registration AND the name contract at once).
4. **Run `npm run test:mutation`** — confirm it exits 0 and no mutants survive.

**Anti-patterns:**

- Don't delete a mutant just because its anchor moved. If the behavior it verified is still important, re-anchor instead.
- Don't re-anchor on a snippet that appears multiple times in the file — the runner replaces the first occurrence, so non-unique snippets cause silent regressions.
- Don't anchor on comments or whitespace-only lines — edits to those don't represent real behavior changes.

Example from the v2 simplification pass: collapsing three `if (process.env.COPILOT_SUBAGENT_LAUNCH_ID) {` gates into one broke three mutants that anchored on the separate gates. The fix re-anchored each on a distinguishing line *inside* its conditional (the tool's `name` field), which proved a stronger contract: the tool is registered AND it has the expected identifier.

