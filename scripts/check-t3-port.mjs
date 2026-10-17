#!/usr/bin/env node
// Fails when upstream Cursor wording comes back into the T3 port of pstack,
// or when a T3 anchor goes missing. FORK.md's "T3 port intent" says why each rule exists.
// Usage: node scripts/check-t3-port.mjs [root]   (root holds pstack/, defaults to this repo)

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, relative, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const SCANNED = ["pstack/skills", "pstack/agents"];
const TEXT = /\.(md|mjs|js|ts|sh|json|tsv)$/;

const BANNED = [
  {
    id: "cursor-subagent",
    pattern: /\bsubagent_type\b|`Task`|\bTask tool\b|\bgeneralPurpose\b|\breadonly: true\b|\bcloud_base_branch\b|\bis_background\b/,
    fix: "Spawn subagents as T3 delegate_task children with a target from the role file.",
  },
  {
    id: "cursor-rule-file",
    pattern: /~\/\.cursor\/rules|pstack-models\.mdc/,
    fix: "Model roles live in the pstack roles block of ~/lim-v2/AGENTS.md.",
  },
  {
    id: "cursor-ask-tool",
    pattern: /\bAskQuestion\b/,
    fix: "Ask in chat, or with the harness's ask-the-user tool.",
  },
  {
    id: "todo-tool",
    pattern: /\bTodoWrite\b/,
    fix: "Keep the todo list as a checklist file under todos/ in the pstack store.",
  },
  {
    id: "fast-slug",
    pattern: /\b[a-z][a-z0-9.-]*-(?:low|medium|high|xhigh|max)-fast\b/,
    fix: "Speed is a T3 option on the role line (fastMode for Grok, serviceTier for GPT), not a -fast model name.",
  },
  {
    id: "claude-fast-default",
    pattern: /claude[a-zA-Z]*\/claude-[a-z0-9-]+[^\n,`]*\bfastMode=true/,
    fix: "Claude fast mode is never a default. Only the operator turns it on, for a task they name.",
  },
  {
    id: "graphite",
    pattern: /\bgt (?:log|sync|submit|restack|get|create|modify|checkout|track|info)\b|`gt`, or without it|run `gt`|\bno gt,/,
    fix: "Resolve stacks from the PR base chain with gh. Graphite is not installed here.",
  },
  {
    id: "trunk-main",
    pattern: /\borigin\/main\b/,
    fix: "Say the repo's default branch (trunk). For pstack itself, trunk is origin/lim.",
  },
  {
    id: "hidden-skill",
    pattern: /^disable-model-invocation:/m,
    fix: "Keep skills visible. End the description with \"Use only when the user or another skill names it.\"",
  },
];

const NAMED_ONLY = "Use only when the user or another skill names it.";
const AUTO_LOAD = new Set(["control-cli", "control-ui", "deslop", "setup-pstack"]);

const REQUIRED = [
  ["pstack/skills/poteto-mode/SKILL.md", "delegate_task", "Subagents are T3 delegate_task children."],
  ["pstack/skills/poteto-mode/SKILL.md", "~/lim-v2/AGENTS.md", "Roles come from the role file."],
  ["pstack/skills/poteto-mode/SKILL.md", "todos/<YYYY-MM-DD>-<task-slug>.md", "The todo list is a file in the pstack store."],
  ["pstack/skills/poteto-mode/SKILL.md", "Claude fast mode", "State the Claude fast-mode consent rule."],
  ["pstack/skills/setup-pstack/SKILL.md", "~/lim-v2/AGENTS.md", "setup-pstack writes the role file."],
  ["pstack/skills/setup-pstack/SKILL.md", "Claude fast mode", "setup-pstack never writes Claude fast mode."],
  ["pstack/skills/poteto-mode/playbooks/babysit.md", "watch_pull_request", "Babysit wakes on T3's PR watch."],
  ["pstack/skills/poteto-mode/scripts/check-plan.mjs", "show origin/lim:", "Plans re-read playbooks from origin/lim."],
];

// Known drift that a later PR in the current sync removes. An entry that no longer
// matches anything fails the check, so this list shrinks to empty as the sync lands.
const PENDING = [
  { rule: "graphite", file: "pstack/skills/poteto-mode/playbooks/orchestrate.md", until: "sync PR C" },
  { rule: "graphite", file: "pstack/skills/poteto-mode/scripts/orch/store.ts", until: "sync PR C" },
  { rule: "graphite", file: "pstack/skills/poteto-mode/scripts/orch/orch.test.ts", until: "sync PR C" },
  { rule: "trunk-main", file: "pstack/skills/poteto-mode/scripts/worktree-audit.sh", until: "sync PR B" },
  { rule: "cursor-subagent", file: "pstack/agents/poteto-agent.md", until: "sync PR B" },
  { rule: "trunk-main", file: "pstack/skills/poteto-mode/playbooks/autopilot-full.md", until: "sync PR C" },
];

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : TEXT.test(name) ? [path] : [];
  });
}

const failures = [];
const usedPending = new Set();
const fail = (where, id, fix) => failures.push(`${where}  [${id}]  ${fix}`);

for (const path of SCANNED.flatMap((d) => walk(join(root, d)))) {
  const file = relative(root, path);
  const lines = readFileSync(path, "utf-8").split("\n");
  for (const rule of BANNED) {
    const pending = PENDING.findIndex((p) => p.rule === rule.id && p.file === file);
    lines.forEach((line, i) => {
      if (!rule.pattern.test(line)) return;
      if (pending >= 0) usedPending.add(pending);
      else fail(`${file}:${i + 1}`, rule.id, rule.fix);
    });
  }
}

for (const dir of walk(join(root, "pstack/skills")).filter((p) => p.endsWith("/SKILL.md"))) {
  const file = relative(root, dir);
  const name = file.split("/").at(-2);
  const description = readFileSync(dir, "utf-8").match(/^description:\s*(.*(?:\n[ \t]+.*)*)/m)?.[1].replace(/\s+/g, " ") ?? "";
  if (!AUTO_LOAD.has(name) && !description.includes(NAMED_ONLY)) {
    fail(file, "named-only", `End the description with "${NAMED_ONLY}" or add the skill to AUTO_LOAD with a reason.`);
  }
}

for (const [file, needle, why] of REQUIRED) {
  const path = join(root, file);
  if (!existsSync(path) || !readFileSync(path, "utf-8").includes(needle)) {
    fail(file, "missing-anchor", `${why} Expected the text: ${needle}`);
  }
}

PENDING.forEach((p, i) => {
  if (!usedPending.has(i)) {
    fail(p.file, "stale-pending", `No ${p.rule} match left. Delete this PENDING entry (was until ${p.until}).`);
  }
});

if (failures.length) {
  console.error(failures.join("\n"));
  console.error(`\n${failures.length} T3 port problem(s). See FORK.md, "T3 port intent".`);
  process.exit(1);
}
console.log(`T3 port check clean (${PENDING.length} pending entries).`);
