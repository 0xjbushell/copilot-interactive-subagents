# Learning Tests

Throwaway probe extensions used to empirically validate Copilot SDK assumptions during design exploration. Not part of the shipping product.

## How to run a probe

Probes are Copilot CLI extensions. To activate one:

```bash
# Symlink (or copy) into your local extensions dir
ln -s "$PWD/specs/learning-tests/v2-sdk-probe.mjs" \
      ~/.copilot/extensions/v2-sdk-probe/extension.mjs

# Start a fresh interactive copilot session (preferably in a separate
# zellij/tmux pane to avoid extension-reload chaos in your active session)
copilot --allow-all-tools
```

Inside the session, drive the probe via the tools it registers (e.g. `probe_echo`, `probe_start_async`, `probe_dump_state`).

When done:

```bash
rm ~/.copilot/extensions/v2-sdk-probe
```

## Probes

| Probe | Captured findings | Companion log |
|---|---|---|
| `v2-sdk-probe.mjs` | Per-session extension forks, `user.message.source` semantics, hook ordering, `extensions_reload` tears down active connections | `v2-sdk-probe.log` |

Findings drove the v2 design choices documented in `specs/explorations/interactive-subagents-v2.md` (see "SDK Learning-Test Findings" section).
