import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

const skillPath = path.resolve(
  ".github/skills/using-copilot-interactive-subagents/SKILL.md",
);

function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "expected YAML frontmatter");
  return match[1];
}

test("project skill exists with required metadata and trigger language", async () => {
  const skill = await readFile(skillPath, "utf8");
  const meta = frontmatter(skill);

  assert.match(meta, /^name: using-copilot-interactive-subagents$/m);
  assert.match(meta, /^description: /m);
  assert.match(meta, /copilot-interactive-subagents extension/i);
  assert.match(meta, /tmux/i);
  assert.match(meta, /zellij/i);
  assert.match(meta, /parallel/i);
  assert.match(meta, /resume/i);
});

test("project skill documents the core tool workflow and operating constraints", async () => {
  const skill = await readFile(skillPath, "utf8");

  for (const toolName of [
    "copilot_subagent_list_agents",
    "copilot_subagent_launch",
    "copilot_subagent_parallel",
    "copilot_subagent_resume",
    "copilot_subagent_set_title",
  ]) {
    assert.match(skill, new RegExp(toolName));
  }

  assert.match(skill, /exact-name only/i);
  assert.match(skill, /github-copilot/);
  assert.match(skill, /Prefer `tmux` by default/);
  assert.match(skill, /Use `zellij` only from inside an attached zellij session/);
  assert.match(skill, /awaitCompletion: true/);
  assert.match(skill, /launchId|resumePointer/);
  assert.match(skill, /AGENT_NOT_FOUND/);
  assert.match(skill, /BACKEND_UNAVAILABLE/);
  assert.match(skill, /BACKEND_START_UNSUPPORTED/);
  assert.match(skill, /PARALLEL_BACKEND_CONFLICT/);
  assert.match(skill, /RESUME_TARGET_INVALID|LAUNCH_NOT_FOUND/);
  assert.match(skill, /SESSION_ACTIVE/);
  assert.match(skill, /interactive/i);
  assert.match(skill, /fork/i);
});
