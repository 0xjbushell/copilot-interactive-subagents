import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(here, "..", "..", ".github", "skills", "using-copilot-interactive-subagents", "SKILL.md");
const skill = readFileSync(SKILL_PATH, "utf8");

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

test("skill has valid frontmatter with name and description", () => {
  const match = skill.match(FRONTMATTER_RE);
  assert.ok(match, "frontmatter block missing");
  const fm = match[1];
  assert.match(fm, /^name:\s*using-copilot-interactive-subagents/m);
  assert.match(fm, /^description:\s*"[^"]+"/m, "description should be a quoted string");
});

test("description triggers on the v2 intents users actually ask about", () => {
  const desc = skill.match(/description:\s*"([^"]+)"/)[1].toLowerCase();
  for (const keyword of ["pane", "tmux", "zellij", "parallel", "resume", "fork", "interactive", "ping"]) {
    assert.ok(desc.includes(keyword), `description missing trigger keyword: ${keyword}`);
  }
});

test("documents the v2 tool surface (5 parent + 2 child)", () => {
  for (const tool of [
    "copilot_subagent_list_agents",
    "copilot_subagent_launch",
    "copilot_subagent_parallel",
    "copilot_subagent_resume",
    "copilot_subagent_set_title",
    "subagent_done",
    "caller_ping",
  ]) {
    assert.ok(skill.includes(tool), `tool not documented: ${tool}`);
  }
});

test("explains the ping/resume cycle (status + handling)", () => {
  assert.match(skill, /status:\s*"ping"/);
  assert.match(skill, /caller_ping/);
  assert.match(skill, /resume.*task/i);
});

test("documents parallel aggregation including ping rules", () => {
  assert.match(skill, /aggregateStatus/);
  assert.match(skill, /partial-success/);
  assert.match(skill, /pingCount/);
});

test("warns that children cannot spawn further children", () => {
  assert.match(skill, /child/i);
  assert.match(skill, /(filtered|cannot spawn|stripped)/i);
});

test("lists the v2 error codes that callers must handle", () => {
  for (const code of [
    "AGENT_NOT_FOUND",
    "BACKEND_UNAVAILABLE",
    "RESUME_UNSUPPORTED",
    "MANIFEST_VERSION_UNSUPPORTED",
    "STATE_DIR_MISSING",
    "TOOL_TIMEOUT",
  ]) {
    assert.ok(skill.includes(code), `error code not documented: ${code}`);
  }
});

test("traces back to the v2 spec", () => {
  assert.match(skill, /interactive-subagents-v2/);
});

test("stays under the 500-line progressive-disclosure budget", () => {
  const lines = skill.split("\n").length;
  assert.ok(lines < 500, `SKILL.md is ${lines} lines; split into references when >500`);
});
