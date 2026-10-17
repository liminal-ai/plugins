import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repo, "scripts/check-t3-port.mjs");

function copyTree(t) {
  const root = mkdtempSync(join(tmpdir(), "t3-port-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
  ["cursor-visuals", "pstack/skills/ketchup/SKILL.md", (s) => s + "\nDraw numbers as a `/visualize` chart.\n"],
  ["missing-anchor", "pstack/skills/ketchup/SKILL.md", (s) => s.replaceAll("html_render", "a canvas")],
  ["cursor-subagent", "pstack/agents/poteto-agent.md", (s) => s + "\nUse the Task tool for every review.\n"],
  ["cursor-subagent", "pstack/skills/swarm/SKILL.md", (s) => s + '\nSpawn workers with environment: "cloud".\n'],
  ["cursor-subagent", "pstack/skills/swarm/SKILL.md", (s) => s + "\nPass run_in_background so it notifies you.\n"],
  ["cursor-install", "pstack/agents/poteto-agent.md", (s) => s + "\nSearch ~/.cursor/plugins/ for poteto-mode.\n"],
  ["claude-fast-default", "pstack/skills/swarm/SKILL.md", (s) => s + '\n```json\n{"target": {\n  "providerInstanceId": "claudeAgent",\n  "model": "claude-opus-5-5",\n  "options": {"effort": "high", "fastMode": true}\n}}\n```\n'],
  ["named-only", "pstack/skills/why/SKILL.md", (s) => s.replace("names it.", "names it. Apply it to all code tasks.")],
  ["claude-fast-default", "pstack/skills/swarm/SKILL.md", (s) => s + '\n{"target":{"options":{"fastMode":true},"providerInstanceId":"claudeAgent","model":"claude-opus-5-5"}}\n'],
  ["claude-fast-default", "pstack/skills/swarm/SKILL.md", (s) => s + "\nconst target = { providerInstanceId: 'claudeAgent', model: 'claude-opus-5-5', options: { fastMode: true } };\n"],
  ["claude-fast-default", "pstack/skills/swarm/SKILL.md", (s) => s + '\n{"providerInstanceId": "claudeAgent", "options": [{"id": "effort", "value": "high"}, {"id": "fastMode", "value": true}]}\n'],
  ["claude-fast-default", "pstack/skills/swarm/SKILL.md", (s) => s + '\n{"providerInstanceId":"claudeAgent","options":[{"value":true,"id":"fastMode"}]}\n'],
  ["claude-fast-default", "pstack/skills/swarm/SKILL.md", (s) => s + "\nconst target = {\n  providerInstanceId: 'claudeAgent', // } closes this object\n  options: { fastMode: true }\n};\n"],
  ["effort-raise", "pstack/skills/poteto-mode/SKILL.md", (s) => s + "\nRaise it one step for a hard job.\n"],
  ["effort-raise", "pstack/skills/swarm/SKILL.md", (s) => s + "\nA lane may go up to max.\n"],
  ["effort-raise", "pstack/skills/arena/SKILL.md", (s) => s + "\nUse the fast slug when the job is urgent.\n"],
  ["missing-anchor", "pstack/skills/poteto-mode/SKILL.md", (s) => s.replace("Never raise it above the role line", "Raise it when the job needs it")],
  ["trunk-main", "pstack/skills/poteto-mode/scripts/watch-pr/watch-pr", (s) => s + "\n# git fetch origin/main\n"],
];


test("a PENDING entry with no match left fails as stale", (t) => {
  const root = copyTree(t);
  const planted = join(root, "check-t3-port.mjs");
  writeFileSync(
    planted,
    readFileSync(script, "utf-8").replace(
      "const PENDING = [",
      'const PENDING = [\n  { rule: "graphite", file: "pstack/skills/why/SKILL.md", count: 1, until: "never" },',
    ),
  );
  const run = spawnSync(process.execPath, [planted, root], { encoding: "utf-8" });
  assert.equal(run.status, 1);
  assert.match(run.stdout + run.stderr, /\[stale-pending\]/);
});

const accepted = [
  ["a folded description with a blank line", "pstack/skills/why/SKILL.md", (s) => s.replace(/^description: .*$/m, "description: >-\n  Explain why.\n\n  Use only when the user or another skill names it.")],
  ["disable-model-invocation: false", "pstack/skills/how/SKILL.md", (s) => s.replace("---\n", "---\ndisable-model-invocation: false\n")],
  ["a plain description that continues on the next line", "pstack/skills/why/SKILL.md", (s) => s.replace(/^description: .*$/m, "description: Explain why.\n  Use only when the user or another skill names it.")],
  ["a Claude target with fast mode far from it", "pstack/skills/swarm/SKILL.md", (s) => s + '\n{"providerInstanceId": "claudeAgent", "options": {"effort": "high"}}\n' + "\n".repeat(10) + "For Grok use fastMode: true.\n"],
];

test("an extensionless binary file is not scanned", (t) => {
  const root = copyTree(t);
  writeFileSync(join(root, "pstack/skills/swarm/blob"), Buffer.from("\0git fetch origin/main\n"));
  const { code, out } = check(root);
  assert.equal(code, 0, out);
});

for (const [name, file, change] of accepted) {
  test(`${name} passes`, (t) => {
    const root = copyTree(t);
    edit(root, file, change);
    const { code, out } = check(root);
    assert.equal(code, 0, out);
  });
}

for (const [rule, file, change] of regressions) {
  test(`a planted ${rule} regression fails`, (t) => {
    const root = copyTree(t);
    edit(root, file, change);
    const { code, out } = check(root);
    assert.equal(code, 1);
    assert.match(out, new RegExp(`\\[${rule}\\]`));
  });
}
