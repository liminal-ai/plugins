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
    pattern: /\bsubagent_type\b|`Task`|\bTask tool\b|\bgeneralPurpose\b|\breadonly: (?:true|false)\b|\bcloud_base_branch\b|\bis_background\b|\brun_in_background\b|\benvironment: "(?:cloud|local)"/g,
    fix: "Spawn subagents as T3 delegate_task children with a target from the role file.",
  },
  {
    id: "cursor-rule-file",
    pattern: /~\/\.cursor\/rules|pstack-models\.mdc/g,
    fix: "Model roles live in the pstack roles block of ~/lim-v2/AGENTS.md.",
  },
  {
    id: "cursor-install",
    pattern: /~\/\.cursor\/plugins/g,
    fix: "pstack is installed per user at ~/.agents/skills/<name>/SKILL.md. Point at that path.",
  },
  {
    id: "cursor-ask-tool",
    pattern: /\bAskQuestion\b/g,
    fix: "Ask in chat, or with the harness's ask-the-user tool.",
  },
  {
    id: "todo-tool",
    pattern: /\bTodoWrite\b/g,
    fix: "Keep the todo list as a checklist file under todos/ in the pstack store.",
  },
  {
    id: "fast-slug",
    pattern: /\b[a-z][a-z0-9.-]*-(?:low|medium|high|xhigh|max)-fast\b/g,
    fix: "Speed is a T3 option on the role line (fastMode for Grok, serviceTier for GPT), not a -fast model name.",
  },
  {
    id: "claude-fast-default",
    pattern: /claude[a-zA-Z]*\/claude-[a-z0-9-]+[^\n,`]*\bfastMode=true/g,
    fix: "Claude fast mode is never a default. Only the operator turns it on, for work they name.",
  },
  {
    id: "graphite",
    pattern: /\bgt (?:log|sync|submit|restack|get|create|modify|checkout|track|info)\b|`gt`, or without it|run `gt`|\bno gt,/g,
    fix: "Resolve stacks from the PR base chain with gh. Graphite is not installed here.",
  },
  {
    id: "trunk-main",
    pattern: /\borigin\/main\b/g,
    fix: "Say the repo's default branch (trunk). For pstack itself, trunk is origin/lim.",
  },
  {
    id: "hidden-skill",
    pattern: /^disable-model-invocation:\s*true\b/g,
    fix: "Keep skills visible. End the description with \"Use only when the user or another skill names it.\"",
  },
];

// Skill text writes Claude targets only as compact role lines, which the
// claude-fast-default rule covers. A structured target (JSON or JS) naming claudeAgent
// is strict on purpose: fastMode may not appear within 8 lines of it, whatever its
// value or key order. The Speed rule owns Claude fast mode, so examples never show it.
const CLAUDE_PROVIDER = /["']?providerInstanceId["']?\s*:\s*["']claudeAgent["']/;
const NEAR = 8;

const NAMED_ONLY = "Use only when the user or another skill names it.";
// These load from the user's own wording on purpose, so they skip the named-only ending.
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

// Known drift that a later PR in the current sync removes, with the exact number of
// matches allowed. More matches is new drift. Fewer means the count must come down,
// and zero means the entry is stale. So the list shrinks to empty as the sync lands.
const PENDING = [
  { rule: "graphite", file: "pstack/skills/poteto-mode/playbooks/orchestrate.md", count: 3, until: "sync PR C" },
  { rule: "graphite", file: "pstack/skills/poteto-mode/scripts/orch/store.ts", count: 11, until: "sync PR C" },
  { rule: "graphite", file: "pstack/skills/poteto-mode/scripts/orch/orch.test.ts", count: 1, until: "sync PR C" },
  { rule: "trunk-main", file: "pstack/skills/poteto-mode/scripts/worktree-audit.sh", count: 3, until: "sync PR B" },
  { rule: "trunk-main", file: "pstack/skills/poteto-mode/playbooks/autopilot-full.md", count: 2, until: "sync PR C" },
  { rule: "cursor-subagent", file: "pstack/agents/poteto-agent.md", count: 1, until: "sync PR B" },
];

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : TEXT.test(name) ? [path] : [];
  });
}

function description(text) {
  const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const lines = front.split("\n");
  const at = lines.findIndex((l) => /^description:/.test(l));
  if (at < 0) return "";
  const head = lines[at].replace(/^description:\s*/, "");
  const body = /^[>|][-+]?$/.test(head) ? [] : [head];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() && !/^\s/.test(line)) break;
    body.push(line.trim());
  }
  return body.join(" ").replace(/\s+/g, " ").trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim();
}

const failures = [];
const fail = (where, id, fix) => failures.push(`${where}  [${id}]  ${fix}`);
const pendingSeen = PENDING.map(() => 0);

for (const path of SCANNED.flatMap((d) => walk(join(root, d)))) {
  const file = relative(root, path);
  const text = readFileSync(path, "utf-8");
  const lines = text.split("\n");
  for (const rule of BANNED) {
    const pending = PENDING.findIndex((p) => p.rule === rule.id && p.file === file);
    lines.forEach((line, i) => {
      for (const _ of line.matchAll(rule.pattern)) {
        if (pending >= 0) pendingSeen[pending]++;
        else fail(`${file}:${i + 1}`, rule.id, rule.fix);
      }
    });
  }
  lines.forEach((line, i) => {
    if (!CLAUDE_PROVIDER.test(line)) return;
    if (lines.slice(Math.max(0, i - NEAR), i + NEAR + 1).some((l) => /fastMode/.test(l))) {
      fail(`${file}:${i + 1}`, "claude-fast-default", "Claude target examples never mention fastMode. The Speed rule in poteto-mode owns Claude fast mode.");
    }
  });
}

for (const path of walk(join(root, "pstack/skills")).filter((p) => p.endsWith("/SKILL.md"))) {
  const file = relative(root, path);
  const name = file.split("/").at(-2);
  if (!AUTO_LOAD.has(name) && !description(readFileSync(path, "utf-8")).endsWith(NAMED_ONLY)) {
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
  const seen = pendingSeen[i];
  if (seen === 0) fail(p.file, "stale-pending", `No ${p.rule} match left. Delete this PENDING entry (was until ${p.until}).`);
  else if (seen > p.count) fail(p.file, p.rule, `${seen} matches, PENDING allows ${p.count}. Remove the new ones.`);
  else if (seen < p.count) fail(p.file, "stale-pending", `${seen} ${p.rule} matches left. Lower this PENDING count from ${p.count}.`);
});

if (failures.length) {
  console.error(failures.join("\n"));
  console.error(`\n${failures.length} T3 port problem(s). See FORK.md, "T3 port intent".`);
  process.exit(1);
}
console.log(`T3 port check clean (${PENDING.length} pending entries).`);
