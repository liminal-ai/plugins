#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const USAGE = `usage: retro.mjs <command>
  reflect <thread-id> [--title T] [--project P]
  register <thread-id> [--title T] [--project P] [--trail PATH]... [--reflected DIR]
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
const LOCK_WAIT_MS = Number(process.env.RETRO_LOCK_WAIT_MS ?? 30000);
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
const LOCK = join(RETRO, ".lock");

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
const compact = (date) => stamp(date).slice(0, 19).replace(/[-:]/g, "").replace("T", "-");

function atOrNow(at) {
  if (!at) return now();
  const date = new Date(`${at}T12:00:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(at) || Number.isNaN(date.getTime()) || day(date) !== at) refuse(`--at takes a real date as YYYY-MM-DD, got ${at}`);
  return date;
}

function unique(path) {
  let candidate = path;
  for (let n = 2; existsSync(candidate); n++) candidate = `${path}-${n}`;
  return candidate;
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
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

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function withLock(fn) {
  mkdirSync(RETRO, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const holder = Number(existsSync(join(LOCK, "pid")) ? readFileSync(join(LOCK, "pid"), "utf-8") : NaN);
      if (Number.isInteger(holder) && !alive(holder)) {
        rmSync(LOCK, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) refuse(`another retro command holds ${LOCK} (pid ${holder || "unknown"})`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  writeFileSync(join(LOCK, "pid"), String(process.pid));
  try {
    return fn();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
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

function pendingReflects(thread, rounds) {
  const taken = new Set(rounds.flatMap((r) => r.reflects ?? []));
  return thread.reflects.filter((c) => !taken.has(c.dir));
}

function statusOf(thread, rounds) {
  const inRounds = rounds.filter((r) => r.threads.includes(thread.thread));
  const open = inRounds.find((r) => !r.closedAt);
  if (open) return { kind: "in-round", round: open.round };
  const pending = pendingReflects(thread, rounds);
  if (pending.length) return { kind: "waiting", since: Math.min(...pending.map((c) => new Date(c.completedAt).getTime())) };
  if (inRounds.length) return { kind: "retrod", round: inRounds.at(-1).round };
  return { kind: "no-reflect" };
}

function dueReason({ threads, rounds }, at) {
  const open = rounds.find((r) => !r.closedAt);
  if (open) {
    const openDays = Math.floor((at.getTime() - new Date(open.openedAt).getTime()) / DAY);
    const reason = `round ${open.round} has been open ${openDays} day${openDays === 1 ? "" : "s"}`;
    return { due: openDays >= STALE_ROUND_DAYS, reason: openDays >= STALE_ROUND_DAYS ? `${reason}; finish and close it` : reason };
  }
  const waiting = [...threads.values()].map((t) => statusOf(t, rounds)).filter((s) => s.kind === "waiting");
  if (waiting.length === 0) return { due: false, reason: "no reflects waiting" };
  const ageDays = Math.floor((at.getTime() - Math.min(...waiting.map((s) => s.since))) / DAY);
  const summary = `${waiting.length} reflect${waiting.length === 1 ? "" : "s"} waiting, oldest ${ageDays} day${ageDays === 1 ? "" : "s"}`;
  return { due: waiting.length >= DUE_COUNT || ageDays >= DUE_AGE_DAYS, reason: summary };
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

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return lstatSync(p).isDirectory() ? [p, ...walk(p)] : [p];
  });
}

function trailMode(target) {
  const hasLinks = statSync(target).isDirectory() && walk(target).some((p) => lstatSync(p).isSymbolicLink());
  if (hasLinks) return { mode: "copied" };
  if (within(target, real(STORE))) return { mode: "linked" };
  if (within(target, real(tmpdir())) || within(target, "/tmp")) return { mode: "copied" };
  const dir = statSync(target).isDirectory() ? target : dirname(target);
  const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  const gitDir = git("rev-parse", "--path-format=absolute", "--git-dir");
  if (gitDir.status !== 0) return { mode: "copied" };
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  if (real(gitDir.stdout.trim()) !== real(common.stdout.trim())) return { mode: "copied" };
  const tracked = git("ls-files", "--", target).stdout.trim() !== "";
  const dirty = git("status", "--porcelain", "--ignored", "--", target).stdout.trim() !== "";
  if (!tracked || dirty) return { mode: "copied" };
  return { mode: "linked", commit: git("log", "-1", "--format=%H", "--", target).stdout.trim() };
}

function digest(path) {
  const hash = createHash("sha256");
  const visit = (p, rel) => {
    if (statSync(p).isDirectory()) {
      hash.update(`d:${rel}\n`);
      for (const name of readdirSync(p).sort()) visit(join(p, name), join(rel, name));
    } else {
      hash.update(`f:${rel}\n`).update(readFileSync(p));
    }
  };
  visit(path, ".");
  return hash.digest("hex");
}

function copyResolved(src, dest) {
  if (statSync(src).isDirectory()) {
    mkdirSync(dest);
    for (const name of readdirSync(src)) copyResolved(join(src, name), join(dest, name));
  } else {
    copyFileSync(src, dest);
  }
}

function current(rec, source) {
  return rec.trails.filter((t) => t.source === source).at(-1);
}

// Copies are never overwritten: a changed source gets a new version beside the old ones.
function addTrail(home, rec, path, at) {
  const source = resolve(path);
  const last = current(rec, source);
  if (!existsSync(source)) {
    if (last?.mode === "copied" && existsSync(last.path)) {
      console.error(`warning: ${source} is gone; keeping the copy at ${last.path}`);
      return;
    }
    refuse(`trail not found: ${source}`);
  }
  const target = real(source);
  const { mode, commit } = trailMode(target);
  if (mode === "linked") {
    rec.trails = rec.trails.filter((t) => t.source !== source).concat({ source, mode, path: target, ...(commit && { commit }), at: stamp(at) });
    return;
  }
  let sum;
  try {
    sum = digest(source);
  } catch (err) {
    refuse(`cannot read every file under ${source}: ${err.message}`);
  }
  if (last?.mode === "copied" && last.sha256 === sum && existsSync(last.path)) return;
  const dest = unique(join(home, "trails", `${compact(at)}-${basename(source)}`));
  const staged = `${dest}.tmp-${process.pid}`;
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(staged, { recursive: true, force: true });
  copyResolved(source, staged);
  renameSync(staged, dest);
  rec.trails.push({ source, mode, path: dest, sha256: sum, at: stamp(at) });
}

function threadRecord(id, args, at) {
  if (!UUID.test(id ?? "")) refuse(`needs a T3 thread id (a UUID), got ${id ?? "nothing"}`);
  const file = join(RETRO, id, "thread.json");
  const problems = [];
  const rec = (existsSync(file) && readJson(file, problems)) || {
    thread: id,
    title: null,
    project: null,
    firstRegistered: stamp(at),
    lastRegistered: null,
    reflects: [],
    trails: [],
  };
  if (problems.length) refuse(problems.join("\n"));
  if (args.title) rec.title = args.title;
  if (args.project) rec.project = args.project;
  rec.lastRegistered = stamp(at);
  mkdirSync(join(RETRO, id), { recursive: true });
  return { rec, file, home: join(RETRO, id) };
}

function cmdReflect(args) {
  const at = now();
  const { rec, file, home } = threadRecord(args._[0], args, at);
  const dir = unique(join(home, `reflect-${compact(at)}`));
  mkdirSync(dir);
  writeJson(file, rec);
  refreshRegistry();
  console.log(dir);
}

function cmdRegister(args) {
  const at = now();
  const { rec, file, home } = threadRecord(args._[0], args, at);
  for (const trail of args.trail) addTrail(home, rec, trail, at);
  if (args.reflected) {
    const dir = resolve(args.reflected);
    if (!within(dir, home)) refuse(`--reflected takes a folder inside ${home}, got ${dir}`);
    if (!isFile(join(dir, "synthesis.md"))) refuse(`write the reflect outputs first: ${join(dir, "synthesis.md")} is missing`);
    if (!rec.reflects.some((c) => c.dir === dir)) rec.reflects.push({ dir, completedAt: stamp(at) });
  }
  writeJson(file, rec);
  refreshRegistry();
  console.log(home);
}

function threadLabel(t) {
  return `[${t.title ?? t.thread.slice(0, 8)}](t3-thread://v1/${t.thread})`;
}

function currentTrails(t) {
  return [...new Set(t.trails.map((x) => x.source))].map((s) => current(t, s));
}

function trailsCell(t) {
  return currentTrails(t).map((x) => `${x.mode}: \`${x.path}\``).join("<br>") || "none";
}

function findProblems({ threads, rounds, problems }) {
  const out = [...problems];
  for (const t of threads.values()) {
    for (const x of currentTrails(t)) if (!existsSync(x.path)) out.push(`${t.thread}: trail missing at ${x.path}`);
    for (const c of t.reflects) if (!isFile(join(c.dir, "synthesis.md"))) out.push(`${t.thread}: reflect ${c.dir} has no synthesis.md`);
  }
  for (const r of rounds) {
    for (const id of r.threads) if (!threads.has(id)) out.push(`round ${r.round}: thread ${id} is not registered`);
    const required = r.earlier ? ["synthesis.md"] : ROUND_OUTPUTS;
    if (r.closedAt) for (const f of required) if (!isFile(join(ROUNDS, r.round, f))) out.push(`round ${r.round}: closed without ${f}`);
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
  const table = (rows, head) => (rows.length ? [head, head.replace(/[^|]+/g, "---"), ...rows] : ["None."]);
  const decided = (t) => (pendingReflects(t, rounds).some((c) => isFile(join(c.dir, "decisions.md"))) ? "yes" : "no");
  const lines = [
    "# Retro registry",
    "",
    `Generated ${stamp(at)} by \`${SELF} status\`. Do not edit by hand.`,
    "",
    `Round due: ${due.due ? "yes" : "no"}, ${due.reason}.`,
    "",
    "## Waiting for a round",
    "",
    ...table(
      by("waiting").map((t) => `| ${threadLabel(t)} | ${t.project ?? "?"} | ${pendingReflects(t, rounds).map((c) => `\`${c.dir}\``).join("<br>")} | ${decided(t)} | ${trailsCell(t)} |`),
      "| thread | project | reflects | decisions | trails |",
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
  ];
  const problems = findProblems(state);
  if (problems.length) lines.push("", "## Problems", "", ...problems.map((p) => `- ${p}`));
  return `${lines.join("\n")}\n`;
}

function refreshRegistry() {
  const text = renderRegistry(load(), now());
  writeAtomic(join(RETRO, "REGISTRY.md"), text);
  return text;
}

function cmdStatus() {
  process.stdout.write(refreshRegistry());
}

function roundReadme(round, state) {
  const lines = [
    `# Retro round ${round.round}`,
    "",
    round.earlier ? `An earlier retro recorded after the fact: ${round.earlier}.` : "Each thread's home is copied into `inputs/` so later changes do not alter this round.",
    "",
  ];
  for (const id of round.threads) {
    const t = state.threads.get(id);
    const home = join(RETRO, id);
    lines.push(`## ${threadLabel(t)}`, "", `Project: ${t.project ?? "?"}. Home: \`${home}\`, copied to \`inputs/${id}/\`.`, "");
    for (const dir of round.reflects.filter((d) => within(d, home))) lines.push(`- Reflect: \`inputs/${id}/${relative(home, dir) || "."}\``);
    for (const x of currentTrails(t).filter((x) => x.mode === "linked")) lines.push(`- Linked trail: \`${x.path}\`${x.commit ? ` at ${x.commit.slice(0, 12)}` : ""}`);
    lines.push("");
  }
  if (round.inputs.length) lines.push("## Other inputs", "", ...round.inputs.map((p) => `- \`${p}\``), "");
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

function gatherBacklog(entries, threads) {
  const parts = [];
  for (const { id, dirs } of entries) {
    const files = dirs.map((d) => join(d, "backlog.md")).filter(isFile);
    if (files.length) parts.push(`## ${threadLabel(threads.get(id))}`, "", ...files.map((f) => readFileSync(f, "utf-8").trim()), "");
  }
  return parts.length ? `# Backlog\n\n${parts.join("\n")}` : "# Backlog\n\nNo reflect in this set has a backlog.md.\n";
}

function cmdOpen(args) {
  const state = load();
  const open = state.rounds.find((r) => !r.closedAt);
  if (open) refuse(`round ${open.round} is open; close it first`);
  const at = atOrNow(args.at);
  const ids =
    args.threads !== undefined
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
  const reflects = ids.flatMap((id) => pendingReflects(state.threads.get(id), state.rounds).map((c) => c.dir));
  const dir = unique(join(ROUNDS, day(at)));
  const round = { round: basename(dir), openedAt: stamp(at), closedAt: null, threads: ids, reflects, inputs: args.input.map((p) => resolve(p)), earlier: args.earlier ?? null };
  mkdirSync(dir, { recursive: true });
  for (const id of ids) cpSync(join(RETRO, id), join(dir, "inputs", id), { recursive: true });
  writeAtomic(join(dir, "README.md"), roundReadme(round, state));
  writeAtomic(join(dir, "backlog.md"), gatherBacklog(ids.map((id) => ({ id, dirs: reflects.filter((d) => within(d, join(RETRO, id))) })), state.threads));
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
  const missing = required.filter((f) => !isFile(join(ROUNDS, id, f)));
  if (missing.length) refuse(`round ${id} is missing ${missing.join(", ")} in ${join(ROUNDS, id)}`);
  round.closedAt = stamp(atOrNow(args.at));
  writeJson(file, round);
  refreshRegistry();
  console.log(`closed round ${id}`);
}

function cmdBacklog(args) {
  const { threads, rounds } = load();
  const entries = [...threads.values()].map((t) => ({ id: t.thread, dirs: (args.all ? t.reflects : pendingReflects(t, rounds)).map((c) => c.dir) }));
  process.stdout.write(gatherBacklog(entries, threads));
}

// Queued scheduled runs fire right after a late answer, so the quiet window starts at the later of the ask and the answer.
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

const FLAGS = new Set(["all", "answered"]);
const OPTIONS = new Set(["title", "project", "trail", "threads", "input", "at", "earlier", "reflected"]);

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

const COMMANDS = { reflect: cmdReflect, register: cmdRegister, status: cmdStatus, open: cmdOpen, close: cmdClose, backlog: cmdBacklog, remind: cmdRemind };

try {
  const [command, ...rest] = process.argv.slice(2);
  if (!COMMANDS[command]) {
    console.error(USAGE);
    process.exit(command ? 1 : 0);
  }
  const args = parse(rest);
  if (command === "backlog") COMMANDS[command](args);
  else withLock(() => COMMANDS[command](args));
} catch (err) {
  if (!(err instanceof Refusal)) throw err;
  console.error(`retro: ${err.message}`);
  process.exit(1);
}
