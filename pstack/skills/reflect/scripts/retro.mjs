#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

const USAGE = `usage: retro.mjs <command>
  register <thread-id> [--title T] [--project P] [--trail PATH]... [--reflected]
  status
  open [--threads ID,ID] [--input PATH]... [--at YYYY-MM-DD] [--earlier REASON]
  close <round> [--at YYYY-MM-DD]
  backlog [--all]
  remind [--answered]`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = 24 * 60 * 60 * 1000;
const DUE_COUNT = 3;
const DUE_AGE_DAYS = 7;
const ASK_QUIET_HOURS = 20;
const STALE_ROUND_DAYS = 7;
const REGISTRY_REWRITES = 5;
const ROUND_OUTPUTS = ["synthesis.md", "decisions.md", "merge-gate.md"];
const SELF = "node ~/.agents/skills/reflect/scripts/retro.mjs";

class Refusal extends Error {}
const refuse = (msg) => {
  throw new Refusal(msg);
};

function storeDir() {
  if (process.env.PSTACK_STORE) return resolve(process.env.PSTACK_STORE);
  const roleFile = join(homedir(), "lim-v2", "AGENTS.md");
  const line = existsSync(roleFile) && readFileSync(roleFile, "utf-8").match(/pstack store:\s*`?([^`\s]+)/);
  const raw = line ? line[1] : "~/.local/state/pstack";
  return resolve(raw.replace(/^~(?=\/|$)/, homedir()));
}

const STORE = storeDir();
const RETRO = join(STORE, "retro");
const ROUNDS = join(RETRO, "rounds");

function now() {
  return process.env.RETRO_NOW ? new Date(process.env.RETRO_NOW) : new Date();
}

function stamp(date) {
  const off = -date.getTimezoneOffset();
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const local = new Date(date.getTime() + off * 60000).toISOString().slice(0, 19);
  return `${local}${off >= 0 ? "+" : "-"}${pad(off / 60)}:${pad(off % 60)}`;
}

const day = (date) => stamp(date).slice(0, 10);

function atOrNow(at) {
  if (!at) return now();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) refuse(`--at takes YYYY-MM-DD, got ${at}`);
  return new Date(`${at}T12:00:00`);
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

const writeJson = (path, value) => writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);

function readJson(path, problems) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    problems.push(`${path} is unreadable: ${err.message}`);
    return null;
  }
}

function load() {
  const problems = [];
  const threads = new Map();
  const rounds = [];
  if (existsSync(RETRO)) {
    for (const name of readdirSync(RETRO).sort()) {
      const file = join(RETRO, name, "thread.json");
      if (!existsSync(file)) continue;
      const rec = readJson(file, problems);
      if (rec) threads.set(rec.thread, rec);
    }
  }
  if (existsSync(ROUNDS)) {
    for (const name of readdirSync(ROUNDS).sort()) {
      const file = join(ROUNDS, name, "round.json");
      if (!existsSync(file)) continue;
      const rec = readJson(file, problems);
      if (rec) rounds.push(rec);
    }
  }
  rounds.sort((a, b) => new Date(a.openedAt) - new Date(b.openedAt));
  return { threads, rounds, problems };
}

function statusOf(thread, rounds) {
  const taken = rounds.filter((r) => r.threads.includes(thread.thread));
  const last = taken.at(-1);
  if (last && !last.closedAt) return { kind: "in-round", round: last.round };
  const reflectedSince = thread.reflectedAt && (!last || new Date(thread.reflectedAt) > new Date(last.openedAt));
  if (reflectedSince) return { kind: "waiting" };
  if (last) return { kind: "retrod", round: last.round };
  return { kind: "no-reflect" };
}

function dueReason({ threads, rounds }, at) {
  const open = rounds.find((r) => !r.closedAt);
  if (open) {
    const openDays = Math.floor((at.getTime() - new Date(open.openedAt).getTime()) / DAY);
    const reason = `round ${open.round} has been open ${openDays} day${openDays === 1 ? "" : "s"}`;
    return { due: openDays >= STALE_ROUND_DAYS, reason: openDays >= STALE_ROUND_DAYS ? `${reason}; finish and close it` : reason };
  }
  const waiting = [...threads.values()].filter((t) => statusOf(t, rounds).kind === "waiting");
  if (waiting.length === 0) return { due: false, reason: "no reflects waiting" };
  const oldest = Math.min(...waiting.map((t) => new Date(t.reflectedAt).getTime()));
  const ageDays = Math.floor((at.getTime() - oldest) / DAY);
  const summary = `${waiting.length} reflect${waiting.length === 1 ? "" : "s"} waiting, oldest ${ageDays} day${ageDays === 1 ? "" : "s"}`;
  const due = waiting.length >= DUE_COUNT || ageDays >= DUE_AGE_DAYS;
  return { due, reason: summary };
}

function within(path, dir) {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function trailMode(abs) {
  if (within(abs, real(STORE))) return { mode: "linked" };
  if (within(abs, real(tmpdir())) || within(abs, "/tmp")) return { mode: "copied" };
  const dir = statSync(abs).isDirectory() ? abs : dirname(abs);
  const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  const gitDir = git("rev-parse", "--path-format=absolute", "--git-dir");
  if (gitDir.status !== 0) return { mode: "copied" };
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  if (real(gitDir.stdout.trim()) !== real(common.stdout.trim())) return { mode: "copied" };
  const tracked = git("ls-files", "--", abs).stdout.trim() !== "";
  const dirty = git("status", "--porcelain", "--ignored", "--", abs).stdout.trim() !== "";
  if (!tracked || dirty) return { mode: "copied" };
  return { mode: "linked", commit: git("log", "-1", "--format=%H", "--", abs).stdout.trim() };
}

function copyDest(home, trails, source) {
  const taken = new Set(trails.filter((t) => t.source !== source).map((t) => t.path));
  const base = basename(source);
  const names = [base, `${basename(dirname(source))}-${base}`];
  for (let n = 2; names.length < 100; n++) names.push(`${n}-${base}`);
  return names.map((name) => join(home, "trails", name)).find((dest) => !taken.has(dest));
}

function addTrail(home, rec, path, at) {
  const source = resolve(path);
  const existing = rec.trails.find((t) => t.source === source);
  if (!existsSync(source)) {
    if (existing?.mode === "copied" && existsSync(existing.path)) {
      console.error(`warning: ${source} is gone; keeping the copy at ${existing.path}`);
      return;
    }
    refuse(`trail not found: ${source}`);
  }
  const { mode, commit } = trailMode(real(source));
  let entry = { path: source, source, mode, at: stamp(at) };
  if (mode === "copied") {
    const dest = existing?.mode === "copied" ? existing.path : copyDest(home, rec.trails, source);
    mkdirSync(dirname(dest), { recursive: true });
    const staged = `${dest}.tmp-${process.pid}`;
    cpSync(source, staged, { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    renameSync(staged, dest);
    entry = { ...entry, path: dest };
  } else if (commit) {
    entry.commit = commit;
  }
  rec.trails = rec.trails.filter((t) => t.source !== source).concat(entry);
}

function cmdRegister(args) {
  const id = args._[0];
  if (!UUID.test(id ?? "")) refuse(`register needs a T3 thread id (a UUID), got ${id ?? "nothing"}`);
  const at = now();
  const home = join(RETRO, id);
  const file = join(home, "thread.json");
  const problems = [];
  const rec = (existsSync(file) && readJson(file, problems)) || {
    thread: id,
    title: null,
    project: null,
    firstRegistered: stamp(at),
    lastRegistered: null,
    reflectedAt: null,
    trails: [],
  };
  if (problems.length) refuse(problems.join("\n"));
  if (args.title) rec.title = args.title;
  if (args.project) rec.project = args.project;
  mkdirSync(home, { recursive: true });
  for (const trail of args.trail) addTrail(home, rec, trail, at);
  if (args.reflected) {
    if (!existsSync(join(home, "synthesis.md"))) refuse(`write the reflect outputs first: ${join(home, "synthesis.md")} is missing`);
    rec.reflectedAt = stamp(at);
  }
  rec.lastRegistered = stamp(at);
  writeJson(file, rec);
  refreshRegistry();
  console.log(home);
}

function threadLabel(t) {
  return `[${t.title ?? t.thread.slice(0, 8)}](t3-thread://v1/${t.thread})`;
}

function trailsCell(t) {
  return t.trails.map((x) => `${x.mode}: \`${x.path}\``).join("<br>") || "none";
}

function findProblems({ threads, rounds, problems }) {
  const out = [...problems];
  for (const t of threads.values()) {
    const home = join(RETRO, t.thread);
    for (const x of t.trails) if (!existsSync(x.path)) out.push(`${t.thread}: trail missing at ${x.path}`);
    if (t.reflectedAt && !existsSync(join(home, "synthesis.md"))) out.push(`${t.thread}: reflected but ${home}/synthesis.md is missing`);
  }
  for (const r of rounds) {
    for (const id of r.threads) if (!threads.has(id)) out.push(`round ${r.round}: thread ${id} is not registered`);
    const required = r.earlier ? ["synthesis.md"] : ROUND_OUTPUTS;
    if (r.closedAt) for (const f of required) if (!existsSync(join(ROUNDS, r.round, f))) out.push(`round ${r.round}: closed without ${f}`);
  }
  if (rounds.filter((r) => !r.closedAt).length > 1) out.push("more than one round is open");
  if (existsSync(ROUNDS)) {
    for (const name of readdirSync(ROUNDS)) {
      if (!existsSync(join(ROUNDS, name, "round.json"))) out.push(`${join(ROUNDS, name)} has no round.json; an open that did not finish. Remove the folder and open again`);
    }
  }
  return out;
}

function renderRegistry(state, at) {
  const { threads, rounds } = state;
  const all = [...threads.values()].sort((a, b) => a.firstRegistered.localeCompare(b.firstRegistered));
  const by = (kind) => all.filter((t) => statusOf(t, rounds).kind === kind);
  const due = dueReason(state, at);
  const lines = [
    "# Retro registry",
    "",
    `Generated ${stamp(at)} by \`${SELF} status\`. Do not edit by hand.`,
    "",
    `Round due: ${due.due ? "yes" : "no"}, ${due.reason}.`,
    "",
    "## Waiting for a round",
    "",
  ];
  const table = (rows, head) => (rows.length ? [head, head.replace(/[^|]+/g, "---"), ...rows] : ["None."]);
  const decided = (t) => (existsSync(join(RETRO, t.thread, "decisions.md")) ? "yes" : "no");
  lines.push(
    ...table(
      by("waiting").map((t) => `| ${threadLabel(t)} | ${t.project ?? "?"} | ${t.reflectedAt.slice(0, 10)} | ${decided(t)} | ${trailsCell(t)} |`),
      "| thread | project | reflected | decisions | trails |",
    ),
    "",
    "## Registered, no reflect yet",
    "",
    ...table(
      by("no-reflect").map((t) => `| ${threadLabel(t)} | ${t.project ?? "?"} | ${t.firstRegistered.slice(0, 10)} | ${trailsCell(t)} |`),
      "| thread | project | registered | trails |",
    ),
    "",
    "## Rounds",
    "",
    ...table(
      [...rounds].reverse().map((r) => {
        const names = r.threads.map((id) => (threads.has(id) ? threadLabel(threads.get(id)) : id)).join(", ") || r.earlier || "";
        return `| ${r.round} | ${r.closedAt ? `closed ${r.closedAt.slice(0, 10)}` : "**open**"} | ${names} | \`${join(ROUNDS, r.round)}\` |`;
      }),
      "| round | state | threads | folder |",
    ),
  );
  const problems = findProblems(state);
  if (problems.length) lines.push("", "## Problems", "", ...problems.map((p) => `- ${p}`));
  return `${lines.join("\n")}\n`;
}

function refreshRegistry() {
  const path = join(RETRO, "REGISTRY.md");
  for (let i = 0; i < REGISTRY_REWRITES; i++) {
    const at = now();
    const text = renderRegistry(load(), at);
    writeAtomic(path, text);
    if (renderRegistry(load(), at) === text) return text;
  }
  return readFileSync(path, "utf-8");
}

function cmdStatus() {
  process.stdout.write(refreshRegistry());
}

function roundReadme(round, state, extra) {
  const lines = [
    `# Retro round ${round.round}`,
    "",
    round.earlier ? `An earlier retro recorded after the fact: ${round.earlier}.` : "Inputs below are copied into `inputs/` so later changes to a thread's home do not alter this round.",
    "",
  ];
  for (const id of round.threads) {
    const t = state.threads.get(id);
    lines.push(`## ${threadLabel(t)}`, "", `Project: ${t.project ?? "?"}. Reflected: ${t.reflectedAt ?? "no"}. Home: \`${join(RETRO, id)}\`.`, "");
    lines.push(`- Copied inputs: \`inputs/${id}/\``);
    for (const x of t.trails.filter((x) => x.mode === "linked")) lines.push(`- Linked trail: \`${x.path}\`${x.commit ? ` at ${x.commit.slice(0, 12)}` : ""}`);
    lines.push("");
  }
  if (extra.length) lines.push("## Other inputs", "", ...extra.map((p) => `- \`${p}\``), "");
  lines.push(
    "## Outputs, needed before close",
    "",
    "- `synthesis.md`: what the round found across these threads.",
    "- `decisions.md`: the operator's decisions, in the operator's words.",
    "- `merge-gate.md`: how the merge gate script is doing since the last round, and whether it needs refinement or a different approach.",
    "",
    `Then run \`${SELF} close ${round.round}\`.`,
    "",
  );
  return lines.join("\n");
}

function gatherBacklog(ids, threads) {
  const parts = [];
  for (const id of ids) {
    const file = join(RETRO, id, "backlog.md");
    if (!existsSync(file)) continue;
    parts.push(`## ${threadLabel(threads.get(id))}`, "", readFileSync(file, "utf-8").trim(), "");
  }
  return parts.length ? `# Backlog\n\n${parts.join("\n")}` : "# Backlog\n\nNo thread in this set has a backlog.md.\n";
}

function cmdOpen(args) {
  const state = load();
  const open = state.rounds.find((r) => !r.closedAt);
  if (open) refuse(`round ${open.round} is open; close it first`);
  const at = atOrNow(args.at);
  const ids = args.threads !== undefined
    ? [...new Set(args.threads.split(",").map((s) => s.trim()).filter(Boolean))]
    : [...state.threads.values()].filter((t) => statusOf(t, state.rounds).kind === "waiting").map((t) => t.thread);
  for (const id of ids) {
    const t = state.threads.get(id);
    if (!t) refuse(`thread ${id} is not registered; run register first`);
    const s = statusOf(t, state.rounds);
    if (s.kind === "retrod") refuse(`thread ${id} was retro'd in round ${s.round} and has not reflected since`);
  }
  if (ids.length === 0 && !args.earlier) refuse("no threads are waiting; pass --threads to choose some");
  for (const p of args.input) if (!existsSync(p)) refuse(`input not found: ${p}`);
  let id = day(at);
  for (let n = 2; existsSync(join(ROUNDS, id)); n++) id = `${day(at)}-${n}`;
  const dir = join(ROUNDS, id);
  mkdirSync(dir, { recursive: true });
  for (const tid of ids) cpSync(join(RETRO, tid), join(dir, "inputs", tid), { recursive: true });
  const extra = args.input.map((p) => resolve(p));
  const round = { round: id, openedAt: stamp(at), closedAt: null, threads: ids, inputs: extra, earlier: args.earlier ?? null };
  writeAtomic(join(dir, "README.md"), roundReadme(round, state, extra));
  writeAtomic(join(dir, "backlog.md"), gatherBacklog(ids, state.threads));
  writeJson(join(dir, "round.json"), round);
  refreshRegistry();
  console.log(dir);
}

function cmdClose(args) {
  const id = args._[0];
  const file = join(ROUNDS, id ?? "", "round.json");
  if (!id || !existsSync(file)) refuse(`no round ${id ?? "given"}; see ${SELF} status`);
  const problems = [];
  const round = readJson(file, problems);
  if (!round) refuse(problems.join("\n"));
  if (round.closedAt) refuse(`round ${id} closed at ${round.closedAt}`);
  const required = round.earlier ? ["synthesis.md"] : ROUND_OUTPUTS;
  const missing = required.filter((f) => !existsSync(join(ROUNDS, id, f)));
  if (missing.length) refuse(`round ${id} is missing ${missing.join(", ")} in ${join(ROUNDS, id)}`);
  round.closedAt = stamp(atOrNow(args.at));
  writeJson(file, round);
  refreshRegistry();
  console.log(`closed round ${id}`);
}

function cmdBacklog(args) {
  const { threads, rounds } = load();
  const ids = [...threads.values()].filter((t) => args.all || statusOf(t, rounds).kind === "waiting").map((t) => t.thread);
  process.stdout.write(gatherBacklog(ids, threads));
}

function cmdRemind(args) {
  const at = now();
  const file = join(RETRO, "reminder.json");
  const last = (existsSync(file) && readJson(file, [])) || {};
  if (args.answered) {
    writeJson(file, { ...last, lastAnsweredAt: stamp(at) });
    return console.log("recorded the answer");
  }
  const { due, reason } = dueReason(load(), at);
  if (!due) return console.log(`QUIET: ${reason}`);
  const quietWindowStart = Math.max(...[last.lastAskedAt, last.lastAnsweredAt].filter(Boolean).map((x) => new Date(x).getTime()), 0);
  if (at.getTime() < quietWindowStart + ASK_QUIET_HOURS * 3600000) return console.log(`QUIET: asked or answered within ${ASK_QUIET_HOURS} hours; ${reason}`);
  writeJson(file, { ...last, lastAskedAt: stamp(at), reason });
  console.log(`ASK: ${reason}`);
}

const FLAGS = new Set(["reflected", "all", "answered"]);
const OPTIONS = new Set(["title", "project", "trail", "threads", "input", "at", "earlier"]);

function parse(argv) {
  const args = { _: [], trail: [], input: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      args._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (!FLAGS.has(key) && !OPTIONS.has(key)) refuse(`unknown option ${a}`);
    if (FLAGS.has(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) refuse(`${a} needs a value`);
    if (Array.isArray(args[key])) args[key].push(value);
    else args[key] = value;
  }
  return args;
}

const COMMANDS = { register: cmdRegister, status: cmdStatus, open: cmdOpen, close: cmdClose, backlog: cmdBacklog, remind: cmdRemind };

try {
  const [command, ...rest] = process.argv.slice(2);
  if (!COMMANDS[command]) {
    console.error(USAGE);
    process.exit(command ? 1 : 0);
  }
  COMMANDS[command](parse(rest));
} catch (err) {
  if (!(err instanceof Refusal)) throw err;
  console.error(`retro: ${err.message}`);
  process.exit(1);
}
