# Specs Index

This directory contains canonical design specifications for `copilot-interactive-subagents`.

## Subsystem Placement

| Subsystem | Directory | Use When |
| --- | --- | --- |
| Subagent orchestration | `specs/subagents/` | The spec concerns multiplexer-backed subagent launching, monitoring, resume, or workflow orchestration for Copilot CLI. |
| Decisions | `specs/decisions/` | Locked cross-cutting decisions that future specs and execution must honor. |
| Explorations | `specs/explorations/` | Free-form brainstorming artifacts and research notes. |

## Authoring Rules

- Use `specs/SPEC_TEMPLATE.md` as the default section contract.
- Every spec must include a `## Traceability` section near the top.
- Preserve the same shared key across tickets, review artifacts, verification notes, and follow-on design updates.
- Add a new subsystem row here before placing the first spec in a new directory.
