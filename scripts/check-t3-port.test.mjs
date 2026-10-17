import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repo, "scripts/check-t3-port.mjs");

function copyTree() {
  const root = mkdtempSync(join(tmpdir(), "t3-port-"));
  cpSync(join(repo, "pstack"), join(root, "pstack"), {
    recursive: true,
    filter: (src) => !src.includes("node_modules"),
  });
  return root;
}

function edit(root, file, change) {
  const path = join(root, file);
  writeFileSync(path, change(readFileSync(path, "utf-8")));
}

function check(root) {
  const run = spawnSync(process.execPath, [script, root], { encoding: "utf-8" });
  return { code: run.status, out: run.stdout + run.stderr };
}

test("the fork as it stands passes", () => {
  assert.equal(check(repo).code, 0);
});

const regressions = [
  ["missing-anchor", "pstack/skills/poteto-mode/SKILL.md", (s) => s.replaceAll("delegate_task", "Task")],
  ["claude-fast-default", "pstack/skills/setup-pstack/SKILL.md", (s) => s.replace("judgment and prose: claudeAgent/claude-opus-5-5 effort=xhigh", "judgment and prose: claudeAgent/claude-opus-5-5 effort=xhigh fastMode=true")],
  ["hidden-skill", "pstack/skills/how/SKILL.md", (s) => s.replace("---\n", "---\ndisable-model-invocation: true\n")],
  ["cursor-subagent", "pstack/skills/swarm/SKILL.md", (s) => s + "\nSpawn each worker with `subagent_type: generalPurpose`.\n"],
  ["cursor-rule-file", "pstack/skills/setup-pstack/SKILL.md", (s) => s + "\nWrite `~/.cursor/rules/pstack-models.mdc`.\n"],
  ["fast-slug", "pstack/skills/swarm/SKILL.md", (s) => s + "\nDefault `grok-4.7-xhigh-fast`.\n"],
  ["named-only", "pstack/skills/why/SKILL.md", (s) => s.replace(" Use only when the user or another skill names it.", "")],
  ["stale-pending", "pstack/skills/poteto-mode/scripts/worktree-audit.sh", (s) => s.replaceAll("origin/main", "origin/HEAD")],
];

for (const [rule, file, change] of regressions) {
  test(`a planted ${rule} regression fails`, () => {
    const root = copyTree();
    edit(root, file, change);
    const { code, out } = check(root);
    assert.equal(code, 1);
    assert.match(out, new RegExp(`\\[${rule}\\]`));
  });
}
