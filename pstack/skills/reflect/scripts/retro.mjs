#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: retro.mjs <command>
  reflect <thread-id> [--title T] [--project P]
  register <thread-id> [--title T] [--project P] [--model PROVIDER/MODEL@FROM]... [--trail PATH]... [--reflected DIR]
  status
  open [--threads ID,ID] [--input PATH]... [--at YYYY-MM-DD] [--earlier REASON]
  close <round> [--at YYYY-MM-DD]
  archive <round>
  backlog [--all]
  remind [--answered]
  migrate-paths`;

// t3_thread_launch makes mcp: and a UUID, or mcp:launch: and a SHA-256 hex digest when given a clientRequestId.
// create_threads makes thread:mcp:<namespace>:<request key>:<index>, each name run through encodeURIComponent.
// A delegated child's id is its request key run through encodeURIComponent, so it is one path
// component: never "/" or "\\", and its fixed prefix keeps it from being "." or "..".
const THREAD_ID = /^(?:(mcp:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mcp:launch:[0-9a-f]{64}|thread:mcp:(?=.{1,230}$)[A-Za-z0-9\-_.!~*'()%]+:[A-Za-z0-9\-_.!~*'()%]+:\d+|thread:delegated-task:[A-Za-z0-9\-_.!~*'()%]{1,220})$/;
// FROM is where the model took over: a run ordinal from t3_thread_read's recentRuns, such as run-12, or a date.
const MODEL = /^([\w.-]+)\/([\w.:-]+)@(run-\d+|\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?)$/;
const DAY = 24 * 60 * 60 * 1000;
const DUE_COUNT = 3;
const DUE_AGE_DAYS = 7;
const ASK_QUIET_HOURS = 20;
const STALE_ROUND_DAYS = 7;
const LOCK_WAIT_MS = Number(process.env.RETRO_LOCK_WAIT_MS ?? 30000);
const ROUND_OUTPUTS = ["synthesis.md", "decisions.md", "merge-gate.md"];
const SELF = "node ~/.agents/skills/reflect/scripts/retro.mjs";
const ROUND_ID = /^\d{4}-\d{2}-\d{2}(-\d+)?$/;
const ARCHIVE = resolve(process.env.RETRO_ARCHIVE ?? "/archive/retro");
const ARCHIVE_KEEP_DAYS = 7;

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
const GIT_DIR = join(RETRO, ".git");
const BACKUP_STATE = join(GIT_DIR, "retro-backup.json");
const GITLEAKS_REPORT = join(GIT_DIR, "retro-gitleaks.json");
const REMOTE_TIMEOUT_MS = 15000;
const BACKUP_BRANCH = "main";
// The same patterns as the retro folder's .gitignore. Staging forces past every other ignore rule, because a copied trail can carry its own.
const NEVER_BACKED_UP = [".lock", "*.tmp-*"];

// gitleaks' default rules plus the key types retro transcripts have held.
const GITLEAKS_CONFIG = join(dirname(fileURLToPath(import.meta.url)), "gitleaks.toml");

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

// flock(1) holds a kernel lock for the whole command, so a crash or a reused pid can never leave it stuck.
function underLock(argv) {
  mkdirSync(RETRO, { recursive: true });
  const r = spawnSync("flock", ["-E", "75", "-w", String(LOCK_WAIT_MS / 1000), LOCK, process.execPath, fileURLToPath(import.meta.url), ...argv], {
    stdio: "inherit",
    env: { ...process.env, RETRO_LOCKED: "1" },
  });
  if (r.error?.code === "ENOENT") refuse("retro.mjs needs flock(1) on PATH");
  if (r.status === 75) refuse(`another retro command held ${LOCK} for ${LOCK_WAIT_MS / 1000}s; try again`);
  process.exitCode = r.status ?? 1;
}

function load() {
  const problems = [];
  const threads = new Map();
  const rounds = [];
  if (existsSync(RETRO)) {
    for (const name of readdirSync(RETRO).sort()) {
      const file = join(RETRO, name, "thread.json");
      if (!existsSync(file)) continue;
      const rec = readRecord(file, problems);
      if (rec) threads.set(rec.thread, rec);
    }
  }
  if (existsSync(ROUNDS)) {
    for (const name of readdirSync(ROUNDS).sort()) {
      const file = join(ROUNDS, name, "round.json");
      if (!existsSync(file)) continue;
      const rec = readRecord(file, problems);
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
  if (pending.length) return { kind: "waiting" };
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
  const waiting = [...threads.values()].flatMap((t) => pendingReflects(t, rounds)).map((c) => new Date(c.completedAt).getTime());
  if (waiting.length === 0) return { due: false, reason: "no reflects waiting" };
  const ageDays = Math.floor((at.getTime() - Math.min(...waiting)) / DAY);
  const summary = `${waiting.length} reflect${waiting.length === 1 ? "" : "s"} waiting, oldest ${ageDays} day${ageDays === 1 ? "" : "s"}`;
  return { due: waiting.length >= DUE_COUNT || ageDays >= DUE_AGE_DAYS, reason: summary };
}

function within(path, dir) {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

const storedPath = (path) => (within(path, RETRO) ? relative(RETRO, path) : path);

const RETRO_FROM_HOME = within(RETRO, homedir()) && `${sep}${relative(homedir(), RETRO)}${sep}`;

function pathFromAnyStore(path) {
  if (!isAbsolute(path)) return join(RETRO, path);
  const at = RETRO_FROM_HOME && !within(path, RETRO) ? path.indexOf(RETRO_FROM_HOME) : -1;
  return at === -1 ? path : join(RETRO, path.slice(at + RETRO_FROM_HOME.length));
}

const RECORD_PATHS = {
  "thread.json": (rec, f) => ({ ...rec, reflects: rec.reflects.map((c) => ({ ...c, dir: f(c.dir) })), trails: rec.trails.map((t) => ({ ...t, source: f(t.source), path: f(t.path) })) }),
  "round.json": (rec, f) => ({ ...rec, reflects: rec.reflects.map(f), inputs: rec.inputs.map((x) => ({ ...x, source: f(x.source), copy: f(x.copy) })) }),
};

function readRecord(file, problems) {
  const rec = readJson(file, problems);
  return rec && RECORD_PATHS[basename(file)](rec, pathFromAnyStore);
}

const recordText = (file, rec) => `${JSON.stringify(RECORD_PATHS[basename(file)](rec, storedPath), null, 2)}\n`;
const writeRecord = (file, rec) => writeAtomic(file, recordText(file, rec));

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

// A trail is linked only when the backup can always recover it: it is in the retro folder, or committed, clean and pushed.
function trailMode(target) {
  const hasLinks = statSync(target).isDirectory() && walk(target).some((p) => lstatSync(p).isSymbolicLink());
  if (hasLinks) return { mode: "copied" };
  if (within(target, real(RETRO))) return { mode: "linked" };
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
  const commit = git("log", "-1", "--format=%H", "--", target).stdout.trim();
  const pushed = git("branch", "-r", "--contains", commit).stdout.trim() !== "";
  return pushed ? { mode: "linked", commit } : { mode: "copied" };
}

// An export is a folder retro-export-thread wrote: its MANIFEST.json names the thread and the export time.
// Exports are full transcripts, so they are never backed up, and close moves them to the archive drive.
function isExport(dir) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "MANIFEST.json"), "utf-8"));
    return Boolean(manifest.thread && manifest.exportedAt);
  } catch {
    return false;
  }
}

function findExports(dir) {
  if (!existsSync(dir)) return [];
  if (isExport(dir)) return [dir];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== ".git")
    .flatMap((e) => findExports(join(dir, e.name)));
}

function digest(path) {
  const sha = (data) => createHash("sha256").update(data).digest("hex");
  const tree = (p) => (statSync(p).isDirectory() ? Object.fromEntries(readdirSync(p).sort().map((n) => [n, tree(join(p, n))])) : sha(readFileSync(p)));
  return sha(JSON.stringify(tree(path)));
}

// A copied .git would reach the backup as a bare gitlink, so copies keep only the files.
function copyResolved(src, dest) {
  if (statSync(src).isDirectory()) {
    mkdirSync(dest);
    for (const name of readdirSync(src)) if (name !== ".git") copyResolved(join(src, name), join(dest, name));
  } else {
    copyFileSync(src, dest);
  }
}

function current(rec, source) {
  return rec.trails.filter((t) => t.source === source).at(-1);
}

// Every check and read happens here, before anything is copied, so a refusal leaves nothing behind.
function planTrail(rec, path) {
  const source = resolve(path);
  const last = current(rec, source);
  if (!existsSync(source)) {
    if (last?.mode === "copied" && existsSync(last.path)) return { kind: "keep", source, path: last.path };
    refuse(`trail not found: ${source}`);
  }
  const target = real(source);
  const { mode, commit } = trailMode(target);
  if (mode === "linked") return { kind: "link", source, target, commit };
  if (within(real(STORE), target)) refuse(`trail ${source} contains the pstack store; name something inside it instead`);
  let sum;
  try {
    sum = digest(source);
  } catch (err) {
    refuse(`cannot read every file under ${source}: ${err.message}`);
  }
  if (last?.mode === "copied" && last.sha256 === sum && existsSync(last.path)) return { kind: "same" };
  return { kind: "copy", source, sum };
}

// Copies are never overwritten: a changed source gets a new version beside the old ones.
function applyTrail(home, rec, plan, at) {
  if (plan.kind === "keep") return console.error(`warning: ${plan.source} is gone; keeping the copy at ${plan.path}`);
  if (plan.kind === "same") return;
  const { source } = plan;
  if (plan.kind === "link") {
    const entry = { source, mode: "linked", path: plan.target, ...(plan.commit && { commit: plan.commit }), at: stamp(at) };
    rec.trails = rec.trails.filter((t) => !(t.source === source && t.mode === "linked")).concat(entry);
    return;
  }
  const dest = unique(join(home, "trails", `${compact(at)}-${basename(source)}`));
  const staged = `${dest}.tmp-${process.pid}`;
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(staged, { recursive: true, force: true });
  copyResolved(source, staged);
  renameSync(staged, dest);
  rec.trails.push({ source, mode: "copied", path: dest, sha256: plan.sum, at: stamp(at) });
}

function threadRecord(id, args, at) {
  if (!THREAD_ID.test(id ?? "")) refuse(`needs a T3 thread id (a UUID, mcp: and a UUID, mcp:launch: and 64 hex, create_threads' thread:mcp:..., or a child's thread:delegated-task:... id), got ${id ?? "nothing"}`);
  const file = join(RETRO, id, "thread.json");
  const problems = [];
  const rec = (existsSync(file) && readRecord(file, problems)) || {
    thread: id,
    title: null,
    project: null,
    firstRegistered: stamp(at),
    lastRegistered: null,
    reflects: [],
    trails: [],
  };
  rec.models ??= [];
  if (problems.length) refuse(problems.join("\n"));
  if (args.title) rec.title = args.title;
  if (args.project) rec.project = args.project;
  for (const value of args.model) {
    const m = MODEL.exec(value);
    if (!m) refuse(`--model takes <provider>/<model>@<from>, where <from> is run-<ordinal> or a date, got ${value}`);
    const [, provider, model, from] = m;
    if (!rec.models.some((x) => x.provider === provider && x.model === model && x.from === from)) rec.models.push({ provider, model, from, recorded: stamp(at) });
  }
  rec.lastRegistered = stamp(at);
  mkdirSync(join(RETRO, id), { recursive: true });
  return { rec, file, home: join(RETRO, id) };
}

function cmdReflect(args) {
  const at = now();
  const { rec, file, home } = threadRecord(args._[0], args, at);
  const dir = unique(join(home, `reflect-${compact(at)}`));
  mkdirSync(dir);
  writeRecord(file, rec);
  save(`reflect ${rec.thread}`);
  console.log(dir);
}

function cmdRegister(args) {
  const at = now();
  const { rec, file, home } = threadRecord(args._[0], args, at);
  const dir = args.reflected && resolve(args.reflected);
  if (dir && !within(dir, home)) refuse(`--reflected takes a folder inside ${home}, got ${dir}`);
  if (dir && !isFile(join(dir, "synthesis.md"))) refuse(`write the reflect outputs first: ${join(dir, "synthesis.md")} is missing`);
  const plans = [...new Set(args.trail.map((trail) => resolve(trail)))].map((trail) => planTrail(rec, trail));
  for (const plan of plans) applyTrail(home, rec, plan, at);
  if (dir && !rec.reflects.some((c) => c.dir === dir)) rec.reflects.push({ dir, completedAt: stamp(at) });
  writeRecord(file, rec);
  save(`register ${rec.thread}`);
  console.log(home);
}

function threadLabel(t) {
  const target = `t3-thread://v1/${t.thread}`;
  // A parenthesis in a child's id would end a bare link target early, so such a target goes in angle brackets.
  return `[${t.title ?? t.thread.replace(/^(?:mcp:(?:launch:)?|thread:mcp:[^:]*:|thread:delegated-task:)/, "").slice(0, 8)}](${/[()]/.test(t.thread) ? `<${target}>` : target})`;
}

function currentTrails(t) {
  return [...new Set(t.trails.map((x) => x.source))].map((s) => current(t, s));
}

function modelsCell(t) {
  return (t.models ?? []).map((x) => `${x.provider}/${x.model} from ${x.from}`).join("<br>") || "not recorded";
}

function trailsCell(t) {
  return currentTrails(t).map((x) => (x.archived ? `archived: \`${x.archived}\`` : `${x.mode}: \`${x.path}\``)).join("<br>") || "none";
}

function findProblems({ threads, rounds, problems }) {
  const out = [...problems];
  for (const t of threads.values()) {
    for (const x of currentTrails(t)) if (!x.archived && !existsSync(x.path)) out.push(`${t.thread}: trail missing at ${x.path}`);
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

function renderRegistry(state, at, { secrets, failure }) {
  const { threads, rounds } = state;
  const all = [...threads.values()].sort((a, b) => a.firstRegistered.localeCompare(b.firstRegistered));
  const by = (kind) => all.filter((t) => statusOf(t, rounds).kind === kind);
  const due = dueReason(state, at);
  const table = (rows, head) => (rows.length ? [head, head.replace(/[^|]+/g, "---"), ...rows] : ["None."]);
  const decided = (t) => (pendingReflects(t, rounds).some((c) => isFile(join(c.dir, "decisions.md"))) ? "yes" : "no");
  const lines = [
    "# Retro registry",
    "",
    ...(secrets.length
      ? [
          "## Not backed up: possible secrets",
          "",
          ...secrets.map((x) => `- \`${x.file}\`: ${x.pattern}`),
          "",
          "Nothing is pushed until each one is removed. The next retro command that writes checks again.",
          "",
        ]
      : []),
    ...(failure
      ? ["## Not backed up: the last backup failed", "", `${failure.step} failed at ${failure.at}: ${failure.error}. The next retro command that writes tries again.`, ""]
      : []),
    `Generated ${stamp(at)} by \`${SELF} status\`. Do not edit by hand.`,
    "",
    `Round due: ${due.due ? "yes" : "no"}, ${due.reason}.`,
    "",
    "## Waiting for a round",
    "",
    ...table(
      by("waiting").map((t) => `| ${threadLabel(t)} | ${t.project ?? "?"} | ${modelsCell(t)} | ${pendingReflects(t, rounds).map((c) => `\`${c.dir}\``).join("<br>")} | ${decided(t)} | ${trailsCell(t)} |`),
      "| thread | project | models | reflects | decisions | trails |",
    ),
    "",
    "## Registered, no reflect yet",
    "",
    ...table(
      by("no-reflect").map((t) => `| ${threadLabel(t)} | ${t.project ?? "?"} | ${modelsCell(t)} | ${t.firstRegistered.slice(0, 10)} | ${trailsCell(t)} |`),
      "| thread | project | models | registered | trails |",
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

function refreshRegistry(backup = backupState()) {
  const text = renderRegistry(load(), now(), backup);
  writeAtomic(join(RETRO, "REGISTRY.md"), text);
  return text;
}

function git(...args) {
  return spawnSync("git", ["-C", RETRO, ...args], { encoding: "utf-8", maxBuffer: 1 << 30, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" } });
}

const remoteGit = (...args) => spawnSync("git", ["-C", RETRO, ...args], { encoding: "utf-8", timeout: REMOTE_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

function backupState() {
  try {
    return JSON.parse(readFileSync(BACKUP_STATE, "utf-8"));
  } catch {
    return { secrets: [], failure: null };
  }
}

const runs = (cmd) => spawnSync(cmd, ["version"], { encoding: "utf-8" }).error === undefined;

// $GITLEAKS_PATH if set, else PATH, else the newest install under ~/lim/service/gitleaks, which is not on PATH.
function findGitleaks() {
  const named = process.env.GITLEAKS_PATH;
  if (named) return runs(named) ? { cmd: named } : { error: `GITLEAKS_PATH=${named} does not run` };
  if (runs("gitleaks")) return { cmd: "gitleaks" };
  const installs = join(homedir(), "lim", "service", "gitleaks");
  const versions = existsSync(installs) ? readdirSync(installs).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })) : [];
  const installed = versions.map((v) => join(installs, v, "bin", "gitleaks")).find(runs);
  return installed ? { cmd: installed } : { error: `gitleaks not found in $GITLEAKS_PATH, on PATH, or at ${installs}/*/bin/gitleaks` };
}

// Fails closed: anything but a clean pass or a report of findings counts as a hit.
// A clean pass also needs an empty stderr, because gitleaks exits 0 with an empty report when git log itself fails.
// --text makes git show files it would call binary, such as a log with a NUL byte, which gitleaks otherwise skips.
function scanCommits(gitleaks, range) {
  rmSync(GITLEAKS_REPORT, { force: true });
  const r = spawnSync(
    gitleaks,
    ["git", "--config", GITLEAKS_CONFIG, "--log-opts", ["--text", ...range].join(" "), "--redact", "--no-banner", "--no-color", "--log-level", "error", "--exit-code", "3", "--report-format", "json", "--report-path", GITLEAKS_REPORT, RETRO],
    { encoding: "utf-8" },
  );
  const stderr = (r.stderr ?? "").trim();
  if (r.status === 0 && !stderr) return [];
  try {
    const found = r.status === 3 ? JSON.parse(readFileSync(GITLEAKS_REPORT, "utf-8")) : [];
    if (found.length) return found.map((f) => ({ file: f.File, pattern: `gitleaks ${f.RuleID}` }));
  } catch {}
  return [{ file: ".", pattern: `gitleaks did not finish: ${(stderr || r.error?.message || `exit ${r.status}`).split("\n").at(-1)}` }];
}

// Exports are left out, and one an earlier commit tracked is untracked here, so the next commit drops it.
function stageAll() {
  const exports = findExports(RETRO).map((p) => relative(RETRO, p));
  if (exports.length) git("rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...exports.map((p) => `:(literal)${p}`));
  return git("add", "-A", "--force", "--", ".", ...NEVER_BACKED_UP.map((p) => `:(exclude,glob)**/${p}`), ...exports.map((p) => `:(exclude,literal)${p}`));
}

function backupFailed(state, step, r) {
  const error = (r.stderr || r.error?.message || `exit ${r.status}`).trim().split("\n").at(-1);
  const failed = { ...state, failure: { at: stamp(now()), step, error } };
  writeJson(BACKUP_STATE, failed);
  refreshRegistry(failed);
  console.error(`retro: backup ${step} failed (${error}); nothing new is pushed, and the next retro command that writes tries again`);
}

const later = (a, b) => (!a || (b && new Date(b) > new Date(a)) ? b : a);

// Each side of a rebase conflict as git stages it, or null when that side deleted the file or it is not JSON.
function conflictSide(stage, file) {
  const r = git("show", `:${stage}:${file}`);
  try {
    return r.status === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    return null;
  }
}

// Files the sync settles itself; any other conflicted file needs the operator.
const SETTLERS = {
  "reminder.json": (file) => {
    const [a, b] = [conflictSide(2, file), conflictSide(3, file)];
    if (!a || !b) return false;
    const asked = later(a.lastAskedAt, b.lastAskedAt);
    writeJson(join(RETRO, file), {
      ...a,
      ...b,
      lastAskedAt: asked,
      reason: asked === b.lastAskedAt ? b.reason : a.reason,
      lastAnsweredAt: later(a.lastAnsweredAt, b.lastAnsweredAt),
    });
    return git("add", file).status === 0;
  },
  "REGISTRY.md": (file) => {
    refreshRegistry({ secrets: [], failure: null });
    return git("add", file).status === 0;
  },
};

function rebaseOntoOtherMachines(upstream) {
  if (git("merge-base", "--is-ancestor", upstream, "HEAD").status === 0) return null;
  for (let step = git("rebase", "-q", upstream); step.status !== 0; step = git("rebase", "--continue")) {
    const conflicts = git("diff", "--name-only", "--diff-filter=U").stdout.split("\n").filter(Boolean);
    const unsettled = conflicts.filter((f) => !SETTLERS[f]);
    if (!unsettled.length) unsettled.push(...conflicts.filter((f) => !SETTLERS[f](f)));
    if (!conflicts.length || unsettled.length) {
      git("rebase", "--abort");
      if (!conflicts.length) return step;
      return { stderr: `${unsettled.map((f) => join(RETRO, f)).join(", ")} changed both here and on another machine. This machine's versions stay on disk; ask the operator to settle each file so it holds what both machines should keep` };
    }
  }
  return null;
}

// Every write ends here. A backup failure never fails the command: the work stays on disk and the next write retries.
function save(message) {
  if (!existsSync(GIT_DIR)) {
    refreshRegistry();
    return console.error(`warning: ${RETRO} is not a git repo, so nothing is backed up`);
  }
  const prior = backupState();
  refreshRegistry({ secrets: [], failure: null });
  stageAll();
  const upstream = `refs/remotes/origin/${BACKUP_BRANCH}`;
  const base = git("merge-base", "HEAD", upstream).stdout.trim();
  // Every unpushed commit folds into the new one, so a file a held-back or older commit holds, such as an export, is never pushed.
  const body = base ? git("log", "--format=%s", "HEAD", "--not", "--remotes=origin").stdout.trim().split("\n").filter(Boolean) : [];
  if (body.length) git("reset", "-q", "--soft", base);
  if (git("diff", "--cached", "--quiet").status !== 0) {
    const commit = git("commit", "-q", "--no-verify", "-m", `retro: ${message}`, ...(body.length ? ["-m", `Also holds: ${body.join("; ")}`] : []));
    if (commit.status !== 0) return backupFailed(prior, "commit", commit);
  }
  if (!git("rev-parse", "--verify", "-q", "HEAD").stdout.trim()) return;
  const fetch = remoteGit("fetch", "-q", "origin");
  if (fetch.status !== 0) return backupFailed(prior, "fetch", fetch);
  const synced = git("rev-parse", "--verify", "-q", upstream).stdout.trim() && rebaseOntoOtherMachines(upstream);
  if (synced) return backupFailed(prior, "sync", synced);
  const scanned = git("rev-parse", "--verify", "-q", "HEAD").stdout.trim();
  const range = [scanned, "--not", "--remotes=origin"];
  const unpushed = git("rev-list", "--count", ...range);
  const pending = unpushed.status !== 0 || unpushed.stdout.trim() !== "0";
  const scanner = pending ? findGitleaks() : {};
  if (scanner.error) return backupFailed(prior, "scan", { stderr: `${scanner.error}, so the commits cannot be scanned for secrets. Install gitleaks or set GITLEAKS_PATH` });
  const state = { ...prior, secrets: pending ? scanCommits(scanner.cmd, range) : [] };
  writeJson(BACKUP_STATE, state);
  if (state.secrets.length) {
    refreshRegistry(state);
    for (const x of state.secrets) console.error(`retro: possible secret in ${join(RETRO, x.file)} (${x.pattern}); nothing is pushed until it is removed`);
    return;
  }
  if (pending) {
    const push = remoteGit("push", "-q", "origin", `${scanned}:refs/heads/${BACKUP_BRANCH}`);
    if (push.status !== 0) return backupFailed(state, "push", push);
  }
  if (state.failure) {
    writeJson(BACKUP_STATE, { ...state, failure: null });
    refreshRegistry({ ...state, failure: null });
  }
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
    lines.push(`## ${threadLabel(t)}`, "", `Project: ${t.project ?? "?"}. Models: ${modelsCell(t).replaceAll("<br>", ", ")}. Home: \`${home}\`, copied to \`inputs/${id}/\`.`, "");
    for (const dir of round.reflects.filter((d) => within(d, home))) lines.push(`- Reflect: \`inputs/${id}/${relative(home, dir) || "."}\``);
    for (const x of currentTrails(t).filter((x) => x.mode === "linked")) lines.push(`- Linked trail: \`${x.path}\`${x.commit ? ` at ${x.commit.slice(0, 12)}` : ""}`);
    lines.push("");
  }
  if (round.inputs.length) lines.push("## Other inputs", "", ...round.inputs.map((x) => `- \`${x.source}\`, copied to \`${relative(join(ROUNDS, round.round), x.copy)}\``), "");
  lines.push(
    "## Outputs, needed before close",
    "",
    "- `synthesis.md`: what the round found across these threads.",
    ...(round.earlier
      ? []
      : [
          "- `decisions.md`: the operator's decisions, in the operator's words.",
          "- `merge-gate.md`: how the merge gate script is doing since the last round, and whether it needs refinement or a different approach.",
        ]),
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

// Each round's exports stay on the archive drive for a week after the round. Results in the retro folder are never deleted.
function pruneArchive(at) {
  if (!existsSync(ARCHIVE)) return console.error(`warning: ${ARCHIVE} is missing, so no archived exports were pruned`);
  const today = new Date(`${day(at)}T00:00:00Z`);
  for (const name of readdirSync(ARCHIVE).filter((n) => ROUND_ID.test(n))) {
    if ((today - new Date(`${name.slice(0, 10)}T00:00:00Z`)) / DAY > ARCHIVE_KEEP_DAYS) rmSync(join(ARCHIVE, name), { recursive: true, force: true });
  }
}

function cmdOpen(args) {
  pruneArchive(now());
  const state = load();
  const open = state.rounds.find((r) => !r.closedAt);
  if (open) refuse(`round ${open.round} is open; close it first`);
  const at = atOrNow(args.at);
  const ids =
    args.threads !== undefined
      ? [...new Set(args.threads.split(",").map((s) => s.trim()).filter(Boolean))]
      : args.earlier
        ? []
        : [...state.threads.values()].filter((t) => statusOf(t, state.rounds).kind === "waiting").map((t) => t.thread);
  for (const id of ids) {
    const t = state.threads.get(id);
    if (!t) refuse(`thread ${id} is not registered; run register first`);
    const s = statusOf(t, state.rounds);
    if (s.kind === "retrod") refuse(`thread ${id} was retro'd in round ${s.round} and has not reflected since`);
  }
  if (ids.length === 0 && !args.earlier) refuse("no threads are waiting; pass --threads to choose some");
  for (const p of args.input) if (!existsSync(p)) refuse(`input not found: ${p}`);
  mkdirSync(ROUNDS, { recursive: true });
  for (const p of args.input) if (within(real(ROUNDS), real(p))) refuse(`input ${p} contains the rounds folder; name something inside it instead`);
  const reflects = ids.flatMap((id) => pendingReflects(state.threads.get(id), state.rounds).map((c) => c.dir));
  const dir = unique(join(ROUNDS, day(at)));
  const inputs = args.input.map((p) => ({ source: resolve(p), copy: null }));
  const round = { round: basename(dir), openedAt: stamp(at), closedAt: null, threads: ids, reflects, inputs, earlier: args.earlier ?? null };
  const snapshot = (src, dest) => {
    try {
      copyResolved(src, dest);
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      refuse(`cannot copy ${src} into the round: ${err.message}`);
    }
  };
  mkdirSync(join(dir, "inputs", "other"), { recursive: true });
  for (const id of ids) snapshot(join(RETRO, id), join(dir, "inputs", id));
  for (const input of inputs) {
    input.copy = unique(join(dir, "inputs", "other", basename(input.source)));
    snapshot(input.source, input.copy);
  }
  writeAtomic(join(dir, "README.md"), roundReadme(round, state));
  writeAtomic(join(dir, "backlog.md"), gatherBacklog(ids.map((id) => ({ id, dirs: reflects.filter((d) => within(d, join(RETRO, id))) })), state.threads));
  writeRecord(join(dir, "round.json"), round);
  save(`open round ${round.round}`);
  console.log(dir);
}

function roundRecord(id) {
  const file = join(ROUNDS, id ?? "", "round.json");
  if (!ROUND_ID.test(id ?? "") || !existsSync(file)) refuse(`no round ${id ?? "given"}; see ${SELF} status`);
  const problems = [];
  const round = readRecord(file, problems);
  if (!round) refuse(problems.join("\n"));
  return { file, round };
}

function copyVerified(src, dest, sum) {
  const staged = `${dest}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(staged, { recursive: true, force: true });
    copyResolved(src, staged);
  } catch (err) {
    rmSync(staged, { recursive: true, force: true });
    refuse(`cannot copy ${src} to ${dest}: ${err.message}; nothing was deleted`);
  }
  if (digest(staged) !== sum) {
    rmSync(staged, { recursive: true, force: true });
    refuse(`the copy of ${src} at ${dest} does not match it; nothing was deleted`);
  }
  rmSync(dest, { recursive: true, force: true });
  renameSync(staged, dest);
}

// Every export is copied and verified before any local copy is deleted, and a rerun after a crash at any point converges:
// a verified archive copy is reused, and an export already gone from the round folder was verified before it went.
function archiveRound(round) {
  if (!existsSync(ARCHIVE)) refuse(`${ARCHIVE} is missing, so the round's exports have nowhere to go; mount the archive drive or set RETRO_ARCHIVE`);
  const roundDir = join(ROUNDS, round.round);
  const dest = join(ARCHIVE, round.round);
  const exports = findExports(roundDir);
  for (const dir of exports) {
    const target = join(dest, relative(roundDir, dir));
    const sum = digest(dir);
    if (!(existsSync(target) && digest(target) === sum)) copyVerified(dir, target, sum);
  }
  for (const id of round.threads) {
    const home = join(RETRO, id);
    const file = join(home, "thread.json");
    const rec = existsSync(file) && readRecord(file, []);
    if (!rec) continue;
    const archived = findExports(home)
      .map((dir) => ({ dir, target: join(dest, "inputs", id, relative(home, dir)) }))
      .filter(({ dir, target }) => existsSync(target) && digest(target) === digest(dir));
    if (!archived.length) continue;
    for (const t of rec.trails) {
      const match = archived.find(({ dir }) => t.path === dir);
      if (match) t.archived = match.target;
    }
    writeRecord(file, rec);
    for (const { dir } of archived) rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of exports) rmSync(dir, { recursive: true, force: true });
  round.archive = dest;
}

function cmdClose(args) {
  const id = args._[0];
  const { file, round } = roundRecord(id);
  if (round.closedAt) refuse(`round ${id} closed at ${round.closedAt}`);
  const required = round.earlier ? ["synthesis.md"] : ROUND_OUTPUTS;
  const missing = required.filter((f) => !isFile(join(ROUNDS, id, f)));
  if (missing.length) refuse(`round ${id} is missing ${missing.join(", ")} in ${join(ROUNDS, id)}`);
  const closedAt = atOrNow(args.at);
  if (closedAt < new Date(round.openedAt)) refuse(`round ${id} opened at ${round.openedAt}; it cannot close before that`);
  archiveRound(round);
  round.closedAt = stamp(closedAt);
  writeRecord(file, round);
  save(`close round ${id}`);
  console.log(`closed round ${id}; its exports are in ${round.archive}`);
}

function cmdArchive(args) {
  const id = args._[0];
  const { file, round } = roundRecord(id);
  if (!round.closedAt) refuse(`round ${id} is open; close archives its exports`);
  archiveRound(round);
  writeRecord(file, round);
  save(`archive round ${id}`);
  console.log(`round ${id}'s exports are in ${round.archive}`);
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
    save("remind answered");
    return console.log("recorded the answer");
  }
  const { due, reason } = dueReason(load(), at);
  if (!due) return console.log(`QUIET: ${reason}`);
  const quietWindowStart = Math.max(...[last.lastAskedAt, last.lastAnsweredAt].filter(Boolean).map((x) => new Date(x).getTime()), 0);
  if (at.getTime() < quietWindowStart + ASK_QUIET_HOURS * 3600000) return console.log(`QUIET: asked or answered within ${ASK_QUIET_HOURS} hours; ${reason}`);
  writeJson(file, { ...last, lastAskedAt: stamp(at), reason });
  console.log(`ASK: ${reason}`);
}

function cmdMigratePaths() {
  const homes = existsSync(RETRO) ? readdirSync(RETRO).map((n) => join(RETRO, n, "thread.json")) : [];
  const rounds = existsSync(ROUNDS) ? readdirSync(ROUNDS).map((n) => join(ROUNDS, n, "round.json")) : [];
  const problems = [];
  const rewrites = [...homes, ...rounds].filter(isFile).map((file) => {
    const rec = readRecord(file, problems);
    return { file, text: rec && recordText(file, rec) };
  });
  if (problems.length) refuse(problems.join("\n"));
  const changed = rewrites.filter(({ file, text }) => text !== readFileSync(file, "utf-8"));
  if (!changed.length) return console.log(`every record already stores paths inside ${RETRO} relative to it`);
  for (const { file, text } of changed) writeAtomic(file, text);
  save(`store paths relative to the retro folder in ${changed.length} records`);
  console.log(`rewrote ${changed.length} of ${rewrites.length} records`);
}

const FLAGS = new Set(["all", "answered"]);
const OPTIONS = new Set(["title", "project", "model", "trail", "threads", "input", "at", "earlier", "reflected"]);

function parse(argv) {
  const args = { _: [], trail: [], input: [], model: [] };
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

const COMMANDS = { reflect: cmdReflect, register: cmdRegister, status: cmdStatus, open: cmdOpen, close: cmdClose, archive: cmdArchive, backlog: cmdBacklog, remind: cmdRemind, "migrate-paths": cmdMigratePaths };

try {
  const [command, ...rest] = process.argv.slice(2);
  if (!COMMANDS[command]) {
    console.error(USAGE);
    process.exit(command ? 1 : 0);
  }
  const args = parse(rest);
  if (command === "backlog" || process.env.RETRO_LOCKED) COMMANDS[command](args);
  else underLock([command, ...rest]);
} catch (err) {
  if (!(err instanceof Refusal)) throw err;
  console.error(`retro: ${err.message}`);
  process.exit(1);
}
