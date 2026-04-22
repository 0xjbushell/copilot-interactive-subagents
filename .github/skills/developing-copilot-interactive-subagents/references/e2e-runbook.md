# E2E Runbook

E2E tests spawn **real copilot sessions** in real tmux/zellij panes. They exercise the **installed** extension copy at `~/.copilot/extensions/copilot-interactive-subagents/` — NOT the source-of-truth.

## Always Deploy First

```bash
cp -r .github/extensions/copilot-interactive-subagents ~/.copilot/extensions/copilot-interactive-subagents
npm run test:e2e
```

Skipping the deploy step is the #1 cause of false-positive E2E failures: you fix a bug in source, run E2E, and watch it fail against the stale installed copy.

## Backend Constraints

### tmux
Runs from any terminal: ssh, plain bash, inside tmux, inside zellij — all fine. No special setup.

### zellij — Must Run Inside a Zellij Session
The skip guard at `test/e2e/e2e-helpers.mjs:40` only probes `zellij --version` when `$ZELLIJ` is set in the environment. `$ZELLIJ` is injected by zellij itself when you're inside a session.

**Why the guard exists**: zellij detached sessions (`zellij attach -b --create`) don't render non-default pane content. `dump-screen` returns empty for child panes without a terminal renderer. Tests that scrape pane text would fail spuriously.

### Running Zellij E2E from a Non-Zellij Shell

Nest zellij inside tmux to satisfy the guard with a renderer attached:

```bash
tmux kill-session -t e2ewrap 2>/dev/null
tmux new-session -d -s e2ewrap -x 200 -y 50 "zellij -s e2ezellij"
sleep 3
tmux send-keys -t e2ewrap Escape    # dismiss zellij startup tip
tmux send-keys -t e2ewrap "cd $(pwd) && npm run test:e2e > /tmp/zellij-e2e.log 2>&1; echo DONE-\$? >> /tmp/zellij-e2e.log" Enter

# poll
while ! grep -q '^DONE-' /tmp/zellij-e2e.log 2>/dev/null; do sleep 30; done
tail -20 /tmp/zellij-e2e.log
tmux kill-session -t e2ewrap
```

A full run inside the wrapper takes ~6 minutes and exercises all 27 E2E tests across both backends (vs 18 in tmux-only mode).

## When to Run E2E

| Situation | Run E2E? |
|-----------|----------|
| Pure logic change in `lib/*.mjs` with unit + integration coverage | No — overkill |
| Change to `lib/backend-ops.mjs`, `lib/mux*.mjs`, pane lifecycle | **Yes** |
| Deletion of IPC primitives (signal files, sidecars) | **Yes** — full suite |
| Refactor of signal/sidecar IPC | **Yes** |
| New tool surface (`extension.mjs` tool registration) | **Yes** for tool list/gating |
| Final ship gate before tagging a release | **Yes** — both backends |

## Test Oracles — Trust These, Not Pane Text

Pane text is fragile across terminal renderers. The E2E suite verifies behavior against:

1. **Manifests** — `.copilot-interactive-subagents/launches/<launchId>.json`
2. **Exit sidecars** — `.copilot-interactive-subagents/exit/<launchId>.json`
3. **Session state** — copilot's own session-state files

When debugging failures, inspect these JSON artifacts FIRST. Pane scrapes are best-effort fallbacks, not contracts.

## Isolated Mux Sessions

E2E tests create their own tmux/zellij sessions so they don't pollute your interactive workspace. If a run is interrupted mid-test, orphaned sessions may remain:

```bash
tmux ls 2>/dev/null | grep -E '^cis-e2e-' | cut -d: -f1 | xargs -I{} tmux kill-session -t {}
zellij list-sessions 2>/dev/null | grep -E 'cis-e2e-' | awk '{print $1}' | xargs -I{} zellij delete-session {} --force
```

## Debugging a Failing E2E Test

1. Isolate the failing test:
   ```bash
   node --test --test-name-pattern="<pattern>" test/e2e/<file>.test.mjs
   ```
2. Inspect the manifest at `.copilot-interactive-subagents/launches/<launchId>.json`
3. Inspect the sidecar (if written) at `.copilot-interactive-subagents/exit/<launchId>.json`
4. Re-run with verbose copilot logging if needed (`COPILOT_LOG_LEVEL=debug`)

## What "Passing" Looks Like

A clean E2E run from a non-zellij shell:
```
# tests 27 (or 18 if zellij skipped)
# pass 18-27
# fail 0
# skipped 0-9 (zellij-tagged when not in zellij)
```

Skipped zellij tests are acceptable for inner-loop iteration but **not** for the final ship gate — run inside zellij (or nested via tmux) to clear all 9.
