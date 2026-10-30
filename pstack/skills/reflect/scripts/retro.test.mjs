import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "retro.mjs");
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";

function sandbox(t, { underHome = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), "retro-store-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const store = underHome ? join(base, ".local", "state", "pstack") : base;
  mkdirSync(store, { recursive: true });
  // A gitleaks that finds nothing, so the backup can push; the script's own patterns still scan.
  const scanner = scratchDir(t);
  writeFileSync(join(scanner, "gitleaks"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = (nowIso, extra = {}) => {
    const e = { ...process.env, PSTACK_STORE: store, PATH: `${scanner}:${process.env.PATH}`, ...(underHome && { HOME: base }), ...extra };
    if (nowIso) e.RETRO_NOW = nowIso;
    else delete e.RETRO_NOW;
    return e;
  };
  const run = (args, nowIso, extra) => {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf-8", env: env(nowIso, extra) });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const home = (id) => join(store, "retro", id);
  const inRetro = (path) => join(store, "retro", path);
  const record = (id) => JSON.parse(readFileSync(join(home(id), "thread.json"), "utf-8"));
  const reflect = (id, nowIso, files = {}) => {
    const allocated = run(["reflect", id], nowIso);
    assert.equal(allocated.code, 0, allocated.err);
    const dir = allocated.out.trim();
    writeFileSync(join(dir, "synthesis.md"), "findings\n");
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    assert.equal(run(["register", id, "--reflected", dir], nowIso).code, 0);
    return dir;
  };
  const closeRound = (round, nowIso) => {
    const dir = join(store, "retro", "rounds", round);
    for (const f of ["synthesis.md", "decisions.md", "merge-gate.md"]) writeFileSync(join(dir, f), "x\n");
    return run(["close", round], nowIso);
  };
  return { store, run, home, inRetro, record, reflect, closeRound, env };
}

function scratchDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "retro-scratch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitRepo(t) {
  const base = join(homedir(), ".cache");
  mkdirSync(base, { recursive: true });
  const repo = mkdtempSync(join(base, "retro-test-repo-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
  const remote = `${repo}.remote`;
  t.after(() => rmSync(remote, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q", "--bare", remote]);
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("remote", "add", "origin", remote);
  writeFileSync(join(repo, "decisions.tsv"), "ts\tphase\n");
  git("add", ".");
  git("commit", "-qm", "trail");
  git("push", "-q", "-u", "origin", "HEAD");
  return { repo, git };
}

// Makes the sandbox's retro folder a repo whose backup remote is a local bare repo.
function backedUp(t, store) {
  const retro = join(store, "retro");
  const remote = join(scratchDir(t), "pstack-retros.git");
  const git = (...args) => spawnSync("git", ["-C", retro, ...args], { encoding: "utf-8" });
  const remoteGit = (...args) => spawnSync("git", ["--git-dir", remote, ...args], { encoding: "utf-8" });
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  mkdirSync(retro, { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("remote", "add", "origin", remote);
  writeFileSync(join(retro, ".gitignore"), ".lock\n*.tmp-*\n");
  const pushed = () => remoteGit("log", "--format=%s", "main").stdout.trim().split("\n").filter(Boolean);
  const pushedFiles = () => remoteGit("ls-tree", "-r", "--name-only", "main").stdout.trim().split("\n");
  return { remote, git, remoteGit, pushed, pushedFiles };
}

function otherMachine(t, remote) {
  const box = sandbox(t);
  const retro = join(box.store, "retro");
  spawnSync("git", ["clone", "-q", remote, retro]);
  const git = (...args) => spawnSync("git", ["-C", retro, ...args], { encoding: "utf-8" });
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  return { ...box, git };
}

const FAKE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${"b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW".repeat(3)}\n-----END OPENSSH PRIVATE KEY-----\n`;

test("a thread without a reflect is listed but not waiting", (t) => {
  const { run } = sandbox(t);
  assert.equal(run(["register", A, "--title", "sync", "--project", "pstack-lim"]).code, 0);
  const status = run(["status"]).out;
  assert.match(status, /## Registered, no reflect yet\n\n\| thread[^\n]*\n[^\n]*\n\| \[sync\]\(t3-thread:\/\/v1\/aaaaaaaa/);
  assert.match(status, /## Waiting for a round\n\nNone\./);
  assert.match(status, /Round due: no, no reflects waiting/);
});

test("--reflected refuses until synthesis.md is a file in a folder of the thread's home", (t) => {
  const { run, home, reflect } = sandbox(t);
  const dir = run(["reflect", A]).out.trim();
  assert.ok(dir.startsWith(join(home(A), "reflect-")));
  assert.match(run(["register", A, "--reflected", dir]).err, /synthesis\.md is missing/);
  mkdirSync(join(dir, "synthesis.md"));
  assert.match(run(["register", A, "--reflected", dir]).err, /synthesis\.md is missing/, "a directory is not an output");
  assert.match(run(["register", A, "--reflected", tmpdir()]).err, /takes a folder inside/);
  reflect(B);
  assert.match(run(["status"]).out, /## Waiting for a round\n\n\| thread/);
});

test("rejects an id that is not a thread uuid, an unknown option, and an impossible date", (t) => {
  const { run, reflect } = sandbox(t);
  assert.match(run(["register", "limhealth-restart"]).err, /needs a T3 thread id/);
  assert.match(run(["register", "thread:delegated-task:../../etc"]).err, /needs a T3 thread id/);
  assert.match(run(["register", "thread:delegated-task:a/b"]).err, /needs a T3 thread id/);
  assert.match(run(["register", A, "--titel", "x"]).err, /unknown option --titel/);
  reflect(A);
  assert.match(run(["open", "--at", "2026-02-30"]).err, /takes a real date/);
});

test("a second reflect keeps the first, and a retry keeps the completion time", (t) => {
  const { run, record, reflect } = sandbox(t);
  const first = reflect(A, "2026-10-01T09:00:00Z");
  const second = reflect(A, "2026-10-02T09:00:00Z");
  assert.notEqual(first, second);
  assert.equal(readFileSync(join(first, "synthesis.md"), "utf-8"), "findings\n");
  run(["register", A, "--reflected", first], "2026-10-08T09:00:00Z");
  const reflects = record(A).reflects;
  assert.equal(reflects.length, 2);
  assert.match(reflects[0].completedAt, /^2026-10-0[01]/);
  assert.match(run(["status"], "2026-10-08T10:00:00Z").out, /Round due: yes, 2 reflects waiting, oldest 7 days/);
});

test("copied trails keep every version; an unchanged source adds none", (t) => {
  const { store, run, inRetro, record } = sandbox(t);
  const scratch = scratchDir(t);
  const file = join(scratch, "review.md");
  writeFileSync(file, "first flags\n");
  mkdirSync(join(store, "audit"), { recursive: true });
  writeFileSync(join(store, "audit", "run.tsv"), "row\n");
  run(["register", A, "--trail", file, "--trail", join(store, "audit", "run.tsv")], "2026-10-01T09:00:00Z");
  run(["register", A, "--trail", file], "2026-10-01T10:00:00Z");
  assert.equal(record(A).trails.length, 2, "unchanged source makes no new version");
  assert.equal(record(A).trails.find((x) => x.source === join(store, "audit", "run.tsv")).mode, "copied", "the store outside the retro folder is not backed up");

  writeFileSync(file, "replacement flags\n");
  run(["register", A, "--trail", file], "2026-10-01T11:00:00Z");
  const copies = record(A).trails.filter((x) => x.source === file);
  assert.equal(copies.length, 2);
  assert.equal(readFileSync(inRetro(copies[0].path), "utf-8"), "first flags\n");
  assert.equal(readFileSync(inRetro(copies[1].path), "utf-8"), "replacement flags\n");
  assert.ok(run(["status"]).out.includes(inRetro(copies[1].path)), "status shows the newest version");

  rmSync(file);
  const gone = run(["register", A, "--trail", file]);
  assert.equal(gone.code, 0, "a vanished source keeps its last copy");
  assert.match(gone.err, /keeping the copy/);
  assert.match(run(["register", A, "--trail", join(scratch, "never.tsv")]).err, /trail not found/);
});

test("symlinked trails are materialized or linked by their real target", (t) => {
  const { store, run, inRetro, record } = sandbox(t);
  const scratch = scratchDir(t);
  writeFileSync(join(scratch, "evidence.md"), "e\n");
  mkdirSync(join(scratch, "alias"));
  symlinkSync(join(scratch, "evidence.md"), join(scratch, "alias", "evidence.md"));
  mkdirSync(join(store, "audit"), { recursive: true });
  symlinkSync(join(scratch, "evidence.md"), join(store, "audit", "points-out.md"));
  mkdirSync(join(store, "retro", "notes"), { recursive: true });
  writeFileSync(join(store, "retro", "notes", "real.tsv"), "row\n");
  symlinkSync(join(store, "retro", "notes", "real.tsv"), join(scratch, "alias-to-store.tsv"));

  run(["register", A, "--trail", join(scratch, "alias"), "--trail", join(store, "audit", "points-out.md"), "--trail", join(scratch, "alias-to-store.tsv")]);
  const trails = record(A).trails;
  rmSync(join(scratch, "evidence.md"));
  rmSync(join(scratch, "alias-to-store.tsv"));
  for (const x of trails.filter((x) => x.mode === "copied").map((x) => inRetro(x.path))) {
    const files = lstatSync(x).isDirectory() ? readdirSync(x).map((n) => join(x, n)) : [x];
    for (const f of files) assert.equal(readFileSync(f, "utf-8"), "e\n", `${f} survives its source`);
  }
  assert.equal(trails.filter((x) => x.mode === "copied").length, 2);
  assert.equal(trails.find((x) => x.mode === "linked").path, join("notes", "real.tsv"));
});

test("a committed, clean, pushed trail is linked; unpushed, modified or in a linked worktree it is copied", (t) => {
  const { run, record } = sandbox(t);
  const { repo, git } = gitRepo(t);
  const file = join(repo, "decisions.tsv");
  run(["register", A, "--trail", file]);
  assert.equal(record(A).trails[0].mode, "linked");
  assert.equal(record(A).trails[0].commit, git("rev-parse", "HEAD").stdout.trim());

  const local = join(repo, "local.tsv");
  writeFileSync(local, "row\n");
  git("add", "local.tsv");
  git("commit", "-qm", "local only");
  run(["register", A, "--trail", local]);
  assert.equal(record(A).trails[1].mode, "copied", "a commit no remote has is not a backup");

  writeFileSync(file, "ts\tphase\nedited\n");
  run(["register", B, "--trail", file]);
  assert.equal(record(B).trails[0].mode, "copied");

  git("checkout", "-q", "--", "decisions.tsv");
  const wt = `${repo}-wt`;
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  git("worktree", "add", "-q", wt);
  run(["register", C, "--trail", join(wt, "decisions.tsv")]);
  assert.equal(record(C).trails[0].mode, "copied");
});

test("three waiting reflects make a round due", (t) => {
  const { run, reflect } = sandbox(t);
  reflect(A);
  reflect(B);
  assert.match(run(["status"]).out, /Round due: no, 2 reflects waiting/);
  reflect(C);
  assert.match(run(["status"]).out, /Round due: yes, 3 reflects waiting/);
});

test("one reflect waiting a week makes a round due", (t) => {
  const { run, reflect } = sandbox(t);
  reflect(A, "2026-10-01T09:00:00Z");
  assert.match(run(["status"], "2026-10-07T09:00:00Z").out, /Round due: no, 1 reflect waiting, oldest 6 days/);
  assert.match(run(["status"], "2026-10-08T09:00:00Z").out, /Round due: yes, 1 reflect waiting, oldest 7 days/);
});

test("a round gathers waiting threads, refuses a second open, and closes only with its outputs", (t) => {
  const { store, run, reflect } = sandbox(t);
  const dirA = reflect(A, undefined, { "backlog.md": "- a script for X\n" });
  reflect(B);
  run(["register", C]);

  const opened = run(["open", "--at", "2026-10-20"]);
  assert.equal(opened.code, 0, opened.err);
  const dir = join(store, "retro", "rounds", "2026-10-20");
  assert.equal(opened.out.trim(), dir);
  const round = JSON.parse(readFileSync(join(dir, "round.json"), "utf-8"));
  assert.deepEqual(round.threads.sort(), [A, B]);
  assert.ok(round.reflects.includes(relative(join(store, "retro"), dirA)));
  assert.equal(readFileSync(join(dir, "inputs", A, dirA.split("/").at(-1), "synthesis.md"), "utf-8"), "findings\n");
  assert.match(readFileSync(join(dir, "backlog.md"), "utf-8"), /a script for X/);
  assert.match(readFileSync(join(dir, "README.md"), "utf-8"), /merge-gate\.md/);

  assert.match(run(["open", "--threads", C]).err, /round 2026-10-20 is open/);
  assert.match(run(["status"], "2026-10-21T09:00:00Z").out, /Round due: no, round 2026-10-20 has been open/);

  writeFileSync(join(dir, "synthesis.md"), "s\n");
  writeFileSync(join(dir, "decisions.md"), "d\n");
  mkdirSync(join(dir, "merge-gate.md"));
  assert.match(run(["close", "2026-10-20"]).err, /missing merge-gate\.md/, "a directory is not an output");
  rmSync(join(dir, "merge-gate.md"), { recursive: true });
  writeFileSync(join(dir, "merge-gate.md"), "m\n");
  assert.equal(run(["close", "2026-10-20", "--at", "2026-10-20"]).code, 0);

  const status = run(["status"]).out;
  assert.match(status, /\| 2026-10-20 \| closed 2026-10-20 \|/);
  assert.match(status, /## Waiting for a round\n\nNone\./);
  assert.doesNotMatch(status, /## Problems/);
  assert.match(run(["open", "--threads", A]).err, /was retro'd in round 2026-10-20/);
});

test("a round takes exactly the reflects it copied, whatever its date", (t) => {
  const { run, reflect, closeRound } = sandbox(t);
  reflect(A, "2026-10-17T18:00:00Z");
  run(["open", "--at", "2026-10-16"]);
  closeRound("2026-10-16");
  assert.match(run(["status"]).out, /no reflects waiting/);
  assert.match(run(["open", "--threads", A]).err, /was retro'd/);
  reflect(A, "2026-10-18T09:00:00Z");
  assert.match(run(["status"], "2026-10-18T10:00:00Z").out, /1 reflect waiting/);
});

test("an earlier retro needs no threads and closes on its synthesis alone", (t) => {
  const { store, run } = sandbox(t);
  const old = join(store, "retro", "old-restart");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "notes.md"), "n\n");
  assert.match(run(["open", "--threads", ""]).err, /no threads are waiting/);
  const opened = run(["open", "--threads", "", "--at", "2026-10-16", "--earlier", "before the registry", "--input", old]);
  assert.equal(opened.code, 0, opened.err);
  const dir = join(store, "retro", "rounds", "2026-10-16");
  symlinkSync(join(old, "notes.md"), join(dir, "synthesis.md"));
  assert.equal(run(["close", "2026-10-16", "--at", "2026-10-16"]).code, 0);
  assert.match(run(["status"]).out, /\| 2026-10-16 \| closed 2026-10-16 \| before the registry \|/);
});

test("closing with a dangling output symlink is refused", (t) => {
  const { store, run, reflect } = sandbox(t);
  reflect(A);
  run(["open", "--at", "2026-10-20"]);
  const dir = join(store, "retro", "rounds", "2026-10-20");
  writeFileSync(join(dir, "synthesis.md"), "s\n");
  writeFileSync(join(dir, "merge-gate.md"), "m\n");
  symlinkSync(join(store, "nowhere.md"), join(dir, "decisions.md"));
  assert.match(run(["close", "2026-10-20"]).err, /missing decisions\.md/);
});

test("remind asks once when due, then stays quiet for 20 hours", (t) => {
  const { run, reflect } = sandbox(t);
  reflect(A);
  assert.match(run(["remind"]).out, /^QUIET: 1 reflect waiting/);
  reflect(B);
  reflect(C);
  assert.match(run(["remind"], "2026-11-01T09:00:00Z").out, /^ASK: 3 reflects waiting/);
  assert.match(run(["remind"], "2026-11-01T09:05:00Z").out, /^QUIET: asked or answered/);
  assert.match(run(["remind"], "2026-11-02T05:01:00Z").out, /^ASK:/);
});

test("runs queued behind a late answer stay quiet", (t) => {
  const { run, reflect } = sandbox(t);
  reflect(A);
  reflect(B);
  reflect(C);
  assert.match(run(["remind"], "2026-11-01T09:00:00Z").out, /^ASK:/);
  run(["remind", "--answered"], "2026-11-04T09:00:00Z");
  assert.match(run(["remind"], "2026-11-04T09:01:00Z").out, /^QUIET: asked or answered/);
  assert.match(run(["remind"], "2026-11-05T09:01:00Z").out, /^ASK:/);
});

test("a round left open a week asks to be finished", (t) => {
  const { run, reflect } = sandbox(t);
  reflect(A, "2026-10-01T09:00:00Z");
  run(["open"], "2026-10-01T10:00:00Z");
  assert.match(run(["remind"], "2026-10-07T10:00:00Z").out, /^QUIET: round 2026-10-01 has been open 6 days/);
  assert.match(run(["remind"], "2026-10-08T10:00:00Z").out, /^ASK: round 2026-10-01 has been open 7 days; finish and close it/);
});

test("an open that did not finish is reported and does not block the next", (t) => {
  const { store, run, reflect } = sandbox(t);
  reflect(A);
  mkdirSync(join(store, "retro", "rounds", "2026-10-20"), { recursive: true });
  assert.match(run(["status"]).out, /2026-10-20 has no round\.json/);
  assert.equal(run(["open", "--at", "2026-10-20"]).out.trim(), join(store, "retro", "rounds", "2026-10-20-2"));
});

test("a command waits for the lock and refuses when it stays held; a killed holder frees it", async (t) => {
  const { store, run } = sandbox(t);
  mkdirSync(join(store, "retro"), { recursive: true });
  const holder = spawn("flock", [join(store, "retro", ".lock"), "sleep", "30"], { detached: true });
  const killHolder = () => {
    try {
      process.kill(-holder.pid, "SIGKILL");
    } catch {}
  };
  t.after(killHolder);
  await new Promise((r) => setTimeout(r, 200));
  const blocked = run(["register", A], undefined, { RETRO_LOCK_WAIT_MS: "300" });
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /another retro command held/);
  const exited = new Promise((r) => holder.on("exit", r));
  killHolder();
  await exited;
  assert.equal(run(["register", A], undefined, { RETRO_LOCK_WAIT_MS: "3000" }).code, 0);
});

test("three reflects in one thread make a round due", (t) => {
  const { run, reflect } = sandbox(t);
  reflect(A);
  reflect(A);
  assert.match(run(["status"]).out, /Round due: no, 2 reflects waiting/);
  reflect(A);
  assert.match(run(["remind"]).out, /^ASK: 3 reflects waiting/);
});

test("a changed directory always gets a new copy, even when its bytes could read as file headers", (t) => {
  const { run, record } = sandbox(t);
  const dir = join(scratchDir(t), "trail");
  mkdirSync(dir);
  writeFileSync(join(dir, "a"), "xf:b\ny");
  run(["register", A, "--trail", dir]);
  writeFileSync(join(dir, "a"), "x");
  writeFileSync(join(dir, "b"), "y");
  run(["register", A, "--trail", dir]);
  assert.equal(record(A).trails.length, 2);
});

test("a refused register copies nothing", (t) => {
  const { run, home, record } = sandbox(t);
  const scratch = scratchDir(t);
  writeFileSync(join(scratch, "log.tsv"), "v1\n");
  run(["register", A, "--trail", join(scratch, "log.tsv")]);
  writeFileSync(join(scratch, "log.tsv"), "v2\n");
  assert.match(run(["register", A, "--trail", join(scratch, "log.tsv"), "--trail", join(scratch, "missing.tsv")]).err, /trail not found/);
  assert.match(run(["register", A, "--trail", join(scratch, "log.tsv"), "--reflected", home(A)]).err, /synthesis\.md is missing/);
  assert.equal(record(A).trails.length, 1);
  assert.equal(readdirSync(join(home(A), "trails")).length, 1);
});

test("parallel registrations of one thread keep every trail", async (t) => {
  const { store, run, record, env } = sandbox(t);
  run(["register", A]);
  mkdirSync(join(store, "audit"), { recursive: true });
  const files = Array.from({ length: 6 }, (_, i) => join(store, "audit", `t${i}.tsv`));
  files.forEach((f) => writeFileSync(f, "row\n"));
  await Promise.all(files.map((f) => new Promise((done) => spawn(process.execPath, [script, "register", A, "--trail", f], { env: env() }).on("exit", done))));
  assert.equal(record(A).trails.length, 6);
});

test("a trail that becomes committed keeps the records of its earlier copies", (t) => {
  const { run, record } = sandbox(t);
  const { repo, git } = gitRepo(t);
  const file = join(repo, "decisions.tsv");
  writeFileSync(file, "ts\tphase\nrow\n");
  run(["register", A, "--trail", file]);
  git("commit", "-qam", "row");
  git("push", "-q");
  run(["register", A, "--trail", file]);
  assert.deepEqual(record(A).trails.map((x) => x.mode), ["copied", "linked"]);
});

test("round inputs copy the targets of symlinks in a thread's home", (t) => {
  const { store, run, home, reflect } = sandbox(t);
  const scratch = scratchDir(t);
  writeFileSync(join(scratch, "notes.md"), "n\n");
  const dir = reflect(A);
  symlinkSync(join(scratch, "notes.md"), join(dir, "notes.md"));
  run(["open", "--at", "2026-10-20"]);
  rmSync(join(scratch, "notes.md"));
  const copied = join(store, "retro", "rounds", "2026-10-20", "inputs", A, dir.slice(home(A).length + 1), "notes.md");
  assert.equal(readFileSync(copied, "utf-8"), "n\n");
});

test("close refuses a time before the round opened", (t) => {
  const { store, run, reflect } = sandbox(t);
  reflect(A);
  run(["open", "--at", "2026-10-20"]);
  const dir = join(store, "retro", "rounds", "2026-10-20");
  for (const f of ["synthesis.md", "decisions.md", "merge-gate.md"]) writeFileSync(join(dir, f), "x\n");
  assert.match(run(["close", "2026-10-20", "--at", "2026-10-19"]).err, /cannot close before/);
  assert.equal(run(["close", "2026-10-20", "--at", "2026-10-20"]).code, 0);
});

test("an earlier retro takes no waiting reflects unless named", (t) => {
  const { store, run, reflect } = sandbox(t);
  reflect(A);
  run(["open", "--at", "2026-10-16", "--earlier", "old"]);
  assert.deepEqual(JSON.parse(readFileSync(join(store, "retro", "rounds", "2026-10-16", "round.json"), "utf-8")).threads, []);
});

test("other inputs are copied into the round", (t) => {
  const { store, run, reflect } = sandbox(t);
  const scratch = scratchDir(t);
  writeFileSync(join(scratch, "audit.md"), "a\n");
  reflect(A);
  run(["open", "--at", "2026-10-20", "--input", join(scratch, "audit.md")]);
  rmSync(join(scratch, "audit.md"));
  const dir = join(store, "retro", "rounds", "2026-10-20");
  assert.equal(readFileSync(join(dir, "inputs", "other", "audit.md"), "utf-8"), "a\n");
  assert.match(readFileSync(join(dir, "README.md"), "utf-8"), /copied to `inputs\/other\/audit\.md`/);
});

test("a trail that cannot be read refuses before any trail is copied", (t) => {
  const { run, home, record } = sandbox(t);
  const scratch = scratchDir(t);
  writeFileSync(join(scratch, "log.tsv"), "v1\n");
  run(["register", A, "--trail", join(scratch, "log.tsv")]);
  writeFileSync(join(scratch, "log.tsv"), "v2\n");
  mkdirSync(join(scratch, "broken"));
  symlinkSync(join(scratch, "nowhere"), join(scratch, "broken", "link"));
  assert.match(run(["register", A, "--trail", join(scratch, "log.tsv"), "--trail", join(scratch, "broken")]).err, /cannot read every file/);
  assert.equal(record(A).trails.length, 1);
  assert.equal(readdirSync(join(home(A), "trails")).length, 1);
});

test("an input that contains the rounds folder is refused", (t) => {
  const { store, run, reflect } = sandbox(t);
  reflect(A);
  assert.match(run(["open", "--input", store]).err, /contains the rounds folder/);
  assert.ok(!existsSync(join(store, "retro", "rounds")) || readdirSync(join(store, "retro", "rounds")).length === 0);
});

test("a trail named twice in one command is copied once", (t) => {
  const { run, record } = sandbox(t);
  const file = join(scratchDir(t), "log.tsv");
  writeFileSync(file, "v1\n");
  run(["register", A, "--trail", file, "--trail", file]);
  assert.equal(record(A).trails.length, 1);
});

test("an input that contains the rounds folder through a symlinked store is refused", (t) => {
  const { store, env } = sandbox(t);
  const alias = join(scratchDir(t), "store-alias");
  symlinkSync(store, alias);
  const viaAlias = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf-8", env: { ...env(), PSTACK_STORE: alias } });
  viaAlias(["register", A]);
  assert.match(viaAlias(["open", "--threads", A, "--input", store]).stderr, /contains the rounds folder/);
});

test("close takes only a round id, never a path", (t) => {
  const { store, run } = sandbox(t);
  mkdirSync(join(store, "elsewhere"), { recursive: true });
  writeFileSync(join(store, "elsewhere", "round.json"), JSON.stringify({ round: "x", openedAt: "2026-01-01T00:00:00Z", closedAt: null, threads: [], reflects: [], inputs: [], earlier: "e" }));
  writeFileSync(join(store, "elsewhere", "synthesis.md"), "s\n");
  assert.match(run(["close", "../../elsewhere"]).err, /no round/);
  assert.equal(JSON.parse(readFileSync(join(store, "elsewhere", "round.json"), "utf-8")).closedAt, null);
});

test("a trail that contains the store is refused", (t) => {
  const outer = scratchDir(t);
  const store = join(outer, "store");
  mkdirSync(store);
  const r = spawnSync(process.execPath, [script, "register", A, "--trail", outer], { encoding: "utf-8", env: { ...process.env, PSTACK_STORE: store } });
  assert.match(r.stderr, /contains the pstack store/);
});

test("an earlier round's README asks only for its synthesis", (t) => {
  const { store, run } = sandbox(t);
  run(["open", "--threads", "", "--at", "2026-10-16", "--earlier", "old"]);
  const readme = readFileSync(join(store, "retro", "rounds", "2026-10-16", "README.md"), "utf-8");
  assert.match(readme, /synthesis\.md/);
  assert.doesNotMatch(readme, /merge-gate\.md/);
});

test("a thread an agent created, with an mcp: id, registers and reflects", (t) => {
  const { run, reflect } = sandbox(t);
  const id = "mcp:5f6a3c80-20ac-4892-86dc-6ccda9c470b5";
  reflect(id);
  assert.match(run(["status"]).out, /t3-thread:\/\/v1\/mcp:5f6a3c80/);
  assert.match(run(["register", "thread:other-kind:x"]).err, /needs a T3 thread id/);
});

test("a thread launched with a clientRequestId, with an mcp:launch: id, registers and reflects", (t) => {
  const { run, reflect } = sandbox(t);
  const id = "mcp:launch:e22d9ceca003a06489fc02a4879b12ac02ee7318a7b2f5b312a6c5fc6569814a";
  reflect(id);
  assert.match(run(["status"]).out, /\[e22d9cec\]\(t3-thread:\/\/v1\/mcp:launch:e22d9cec/);
  assert.match(run(["register", `${id}0`]).err, /needs a T3 thread id/);
  assert.match(run(["register", "mcp:launch:../../etc"]).err, /needs a T3 thread id/);
});

test("backlog gathers each waiting reflect's backlog under its thread", (t) => {
  const { run, reflect } = sandbox(t);
  run(["register", A, "--title", "first"]);
  reflect(A, undefined, { "backlog.md": "- item one\n" });
  reflect(B);
  const out = run(["backlog"]).out;
  assert.match(out, /## \[first\]\(t3-thread:\/\/v1\/aaaaaaaa[^\n]*\n\n- item one/);
  assert.doesNotMatch(out, /bbbbbbbb/);
});

test("each write commits the retro folder and pushes it to main", (t) => {
  const { store, run, reflect } = sandbox(t);
  const { pushed, pushedFiles } = backedUp(t, store);
  const dir = reflect(A);
  assert.deepEqual(pushed(), [`retro: register ${A}`, `retro: reflect ${A}`]);
  assert.ok(pushedFiles().includes(`${A}/${dir.split("/").at(-1)}/synthesis.md`));
  assert.ok(pushedFiles().includes("REGISTRY.md"));
  assert.ok(!pushedFiles().includes(".lock"), "the lock file is never backed up");
  run(["open", "--at", "2026-10-20"]);
  for (const f of ["synthesis.md", "decisions.md", "merge-gate.md"]) writeFileSync(join(store, "retro", "rounds", "2026-10-20", f), "x\n");
  run(["close", "2026-10-20", "--at", "2026-10-20"]);
  run(["remind", "--answered"]);
  assert.deepEqual(pushed().slice(0, 3), ["retro: remind answered", "retro: close round 2026-10-20", "retro: open round 2026-10-20"]);
});

test("a failed fetch or push never fails the command, and the next write pushes what waited", (t) => {
  const { store, run } = sandbox(t);
  const { remote, git, pushed } = backedUp(t, store);
  const backup = () => JSON.parse(readFileSync(join(store, "retro", ".git", "retro-backup.json"), "utf-8"));
  git("remote", "set-url", "origin", `${remote}-missing`);
  const offline = run(["register", A]);
  assert.equal(offline.code, 0);
  assert.match(offline.err, /retro: backup fetch failed/);
  assert.equal(backup().failure.step, "fetch");
  assert.deepEqual(pushed(), []);

  git("remote", "set-url", "origin", remote);
  writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const rejected = run(["register", C]);
  assert.equal(rejected.code, 0);
  assert.match(rejected.err, /retro: backup push failed/);
  assert.equal(backup().failure.step, "push");
  assert.deepEqual(pushed(), []);

  rmSync(join(remote, "hooks", "pre-receive"));
  assert.equal(run(["register", B]).err, "");
  assert.deepEqual(pushed(), [`retro: register ${B}`, `retro: register ${C}`, `retro: register ${A}`]);
  assert.equal(backup().failure, null);
});

test("a possible secret blocks the push and heads REGISTRY.md until it is removed", (t) => {
  const { store, run, home } = sandbox(t);
  const { remote, git, pushed } = backedUp(t, store);
  run(["register", A]);
  writeFileSync(join(home(A), "notes.md"), `context\n${FAKE_KEY}`);
  const blocked = run(["register", A]);
  assert.equal(blocked.code, 0);
  assert.match(blocked.err, new RegExp(`possible secret in ${join(home(A), "notes.md")} \\((private key|gitleaks private-key)\\)`));
  assert.match(readFileSync(join(store, "retro", "REGISTRY.md"), "utf-8"), new RegExp(`^# Retro registry\n\n## Not backed up: possible secrets\n\n- \`${A}/notes.md\``));
  assert.deepEqual(pushed(), [`retro: register ${A}`]);
  assert.equal(git("diff", "--cached", "--name-only").stdout, "", "nothing is left staged");

  writeFileSync(join(home(A), "notes.md"), "context\n");
  run(["register", A]);
  assert.equal(pushed().length, 2);
  assert.doesNotMatch(readFileSync(join(store, "retro", "REGISTRY.md"), "utf-8"), /possible secrets/);
  assert.doesNotMatch(spawnSync("git", ["--git-dir", remote, "log", "-p", "--text", "main"], { encoding: "utf-8" }).stdout, /BEGIN OPENSSH/, "the held-back commit never reaches the remote");
});

test("a trail inside the retro folder is linked, since the backup already holds it", (t) => {
  const { store, run, record } = sandbox(t);
  mkdirSync(join(store, "retro", "notes"), { recursive: true });
  writeFileSync(join(store, "retro", "notes", "log.tsv"), "row\n");
  run(["register", A, "--trail", join(store, "retro", "notes", "log.tsv")]);
  assert.equal(record(A).trails[0].mode, "linked");
});

test("a secret in a file git calls binary still blocks the push", (t) => {
  const { store, run, home } = sandbox(t);
  const { pushed } = backedUp(t, store);
  run(["register", A]);
  writeFileSync(join(home(A), "capture.log"), `terminal output\x00\n${FAKE_KEY}`);
  assert.match(run(["register", A]).err, /possible secret in .*capture\.log/);
  assert.deepEqual(pushed(), [`retro: register ${A}`]);
});

test("a copied trail that is a git repo reaches the backup as files, not a gitlink", (t) => {
  const { store, run, inRetro, record } = sandbox(t);
  const { pushedFiles } = backedUp(t, store);
  const { repo, git } = gitRepo(t);
  writeFileSync(join(repo, "decisions.tsv"), "ts\tphase\nunpushed\n");
  git("commit", "-qam", "unpushed");
  run(["register", A, "--trail", repo]);
  const trail = record(A).trails[0];
  assert.equal(trail.mode, "copied");
  assert.ok(pushedFiles().includes(`${trail.path}/decisions.tsv`), "the trail's files are in the backup");
  assert.ok(!existsSync(join(inRetro(trail.path), ".git")));
});

test("a copied trail's own ignore rules do not keep its files out of the backup", (t) => {
  const { store, run, record } = sandbox(t);
  const { pushedFiles } = backedUp(t, store);
  const trail = scratchDir(t);
  writeFileSync(join(trail, ".gitignore"), "*.tsv\n");
  writeFileSync(join(trail, "decisions.tsv"), "ts\tphase\n");
  writeFileSync(join(trail, "run.tmp-1"), "scratch\n");
  run(["register", A, "--trail", trail]);
  const { path } = record(A).trails[0];
  assert.ok(pushedFiles().includes(`${path}/decisions.tsv`));
  assert.ok(!pushedFiles().includes(`${path}/run.tmp-1`), "the retro folder's own rules still apply");
});

test("a file written during the scan or before the push is never pushed unscanned", (t) => {
  const { store, run, home } = sandbox(t);
  const { remote, git, pushed } = backedUp(t, store);
  run(["register", A]);
  const bin = scratchDir(t);
  const payload = join(bin, "payload");
  writeFileSync(payload, `reviewer output\x00\n${FAKE_KEY}`);
  const writeOnce = (target) => `[ -e "$0.done" ] || { cp ${payload} ${target}; touch "$0.done"; }\n`;
  writeFileSync(join(bin, "gitleaks"), `#!/bin/sh\n${writeOnce(join(home(A), "reviewer-output.md"))}exit 0\n`, { mode: 0o755 });
  writeFileSync(join(store, "retro", ".git", "hooks", "pre-push"), `#!/bin/sh\n${writeOnce(join(home(A), "capture.log"))}`, { mode: 0o755 });
  const leaked = () => spawnSync("git", ["--git-dir", remote, "log", "-p", "--text", "main"], { encoding: "utf-8" }).stdout.includes("BEGIN OPENSSH");
  const withWriter = { PATH: `${bin}:${process.env.PATH}` };

  assert.equal(run(["register", A, "--title", "first"], undefined, withWriter).code, 0);
  assert.ok(existsSync(join(home(A), "reviewer-output.md")) && existsSync(join(home(A), "capture.log")), "both writers ran");
  assert.equal(pushed().length, 2, "the scanned commit was pushed");
  assert.ok(!leaked(), "files written after the commit stay off the remote");

  const next = run(["register", A], undefined, withWriter);
  assert.match(next.err, /possible secret in .*reviewer-output\.md/);
  assert.match(next.err, /possible secret in .*capture\.log/);
  assert.equal(pushed().length, 2);
  assert.ok(!leaked());
  assert.equal(git("status", "--porcelain").stdout.split("\n").filter((l) => l && !l.endsWith("REGISTRY.md")).join("\n"), "", "the next write committed them locally");

  rmSync(join(home(A), "reviewer-output.md"));
  rmSync(join(home(A), "capture.log"));
  assert.equal(run(["register", A, "--title", "second"]).err, "");
  assert.equal(pushed().length, 3);
  assert.ok(!leaked(), "the held-back commit is folded away, not pushed");
  assert.equal(git("rev-parse", "HEAD").stdout, spawnSync("git", ["--git-dir", remote, "rev-parse", "main"], { encoding: "utf-8" }).stdout);
});

test("two machines writing to one backup both end up pushed, each rebasing onto the other's commits", (t) => {
  const one = sandbox(t);
  const { remote, remoteGit, pushed, pushedFiles } = backedUp(t, one.store);
  assert.equal(one.run(["register", A]).err, "");
  const two = otherMachine(t, remote);
  assert.equal(one.run(["register", A, "--title", "first"]).err, "");
  assert.equal(two.run(["register", B]).err, "", "the second machine's write rebases onto the first's");
  assert.equal(one.run(["register", C]).err, "", "and the first's next write rebases onto the second's");
  assert.deepEqual(pushed(), [`retro: register ${C}`, `retro: register ${B}`, `retro: register ${A}`, `retro: register ${A}`]);
  assert.equal(remoteGit("rev-list", "--merges", "main").stdout, "", "the backup's history stays a line");
  for (const id of [A, B, C]) assert.ok(pushedFiles().includes(`${id}/thread.json`));
  assert.ok(existsSync(join(one.home(B), "thread.json")), "each machine gets the other's records");
  assert.equal(one.record(A).title, "first");
  assert.equal(two.run(["register", B, "--title", "second"]).err, "");
  assert.ok(existsSync(join(two.home(C), "thread.json")));
  assert.equal(two.record(A).title, "first");
});

test("unpushed commits whose only overlap with the other machine is REGISTRY.md sync on their own", (t) => {
  const one = sandbox(t);
  const { remote, remoteGit, pushed } = backedUp(t, one.store);
  one.run(["register", A]);
  const two = otherMachine(t, remote);
  two.git("remote", "set-url", "origin", `${remote}-missing`);
  two.run(["register", B]);
  two.run(["register", B, "--project", "offline"]);
  assert.equal(one.run(["register", C]).err, "");
  two.git("remote", "set-url", "origin", remote);
  const synced = two.run(["register", B, "--title", "back online"]);
  assert.equal(synced.err, "");
  assert.equal(pushed().length, 5, "all three of the second machine's commits are pushed");
  const registry = remoteGit("show", "main:REGISTRY.md").stdout;
  assert.doesNotMatch(registry, /^(<<<<<<<|=======|>>>>>>>)/m);
  for (const label of ["[aaaaaaaa](", "[back online](", "[cccccccc]("]) assert.ok(registry.includes(label), `the pushed REGISTRY.md lists ${label}`);
  assert.equal(readFileSync(join(two.store, "retro", "REGISTRY.md"), "utf-8"), registry);
  assert.equal(JSON.parse(readFileSync(join(two.store, "retro", ".git", "retro-backup.json"), "utf-8")).failure, null);
});

test("a file both machines changed stops the sync, keeps this machine's work and names the file; the next write retries once it is settled", (t) => {
  const one = sandbox(t);
  const { remote, remoteGit, pushed, pushedFiles } = backedUp(t, one.store);
  one.run(["register", A]);
  const two = otherMachine(t, remote);
  const retro = join(two.store, "retro");
  const notes = join(two.home(A), "notes.md");
  assert.equal(one.run(["register", C]).err, "");
  writeFileSync(join(one.home(A), "notes.md"), "one\n");
  assert.equal(one.run(["register", A]).err, "");

  writeFileSync(notes, "two\n");
  const stopped = two.run(["register", A]);
  assert.equal(stopped.code, 0);
  assert.match(stopped.err, new RegExp(`retro: backup sync failed \\(${notes} changed both here and on another machine\\. .*ask the operator to settle each file.*the next retro command that writes tries again`));
  assert.doesNotMatch(stopped.err, /REGISTRY\.md/, "REGISTRY.md is never the operator's to settle");
  assert.equal(readFileSync(notes, "utf-8"), "two\n", "this machine's version stays on disk");
  assert.equal(two.git("show", `HEAD:${A}/notes.md`).stdout, "two\n", "and committed");
  assert.ok(!existsSync(join(retro, ".git", "rebase-merge")) && !existsSync(join(retro, ".git", "rebase-apply")), "no rebase is left half done");
  assert.equal(two.git("status", "--porcelain").stdout.split("\n").filter((l) => l && !l.endsWith("REGISTRY.md")).join("\n"), "");
  assert.equal(JSON.parse(readFileSync(join(retro, ".git", "retro-backup.json"), "utf-8")).failure.step, "sync");
  assert.match(readFileSync(join(retro, "REGISTRY.md"), "utf-8"), new RegExp(`## Not backed up: the last backup failed\n\nsync failed at \\S+: ${notes} changed both here`));
  assert.deepEqual(pushed(), [`retro: register ${A}`, `retro: register ${C}`, `retro: register ${A}`]);

  assert.match(two.run(["register", B]).err, /backup sync failed .*notes\.md/, "an unsettled file stops every write");
  writeFileSync(notes, readFileSync(join(one.home(A), "notes.md")));
  const settled = two.run(["register", B, "--title", "settled"]);
  assert.equal(settled.err, "");
  assert.equal(pushed()[0], `retro: register ${B}`);
  assert.equal(remoteGit("show", `main:${A}/notes.md`).stdout, "one\n");
  assert.ok(pushedFiles().includes(`${B}/thread.json`) && pushedFiles().includes(`${C}/thread.json`), "the settled write keeps both machines' records");
  assert.equal(two.git("rev-parse", "HEAD").stdout, remoteGit("rev-parse", "main").stdout);
  assert.equal(JSON.parse(readFileSync(join(retro, ".git", "retro-backup.json"), "utf-8")).failure, null);
  assert.doesNotMatch(readFileSync(join(retro, "REGISTRY.md"), "utf-8"), /Not backed up/);
});

test("reminder.json changed on both machines settles to the later ask and the later answer", (t) => {
  const one = sandbox(t);
  const { remote, remoteGit, pushed } = backedUp(t, one.store);
  one.run(["register", A]);
  const two = otherMachine(t, remote);
  const reminder = (box) => join(box.store, "retro", "reminder.json");
  writeFileSync(reminder(one), JSON.stringify({ lastAskedAt: "2026-10-21T08:00:00+00:00", reason: "asked on one" }));
  assert.equal(one.run(["remind", "--answered"], "2026-10-21T09:00:00Z").err, "");
  writeFileSync(reminder(two), JSON.stringify({ lastAskedAt: "2026-10-21T09:30:00+05:00", reason: "asked on two" }));

  const synced = two.run(["remind", "--answered"], "2026-10-22T09:00:00Z");
  assert.equal(synced.err, "");
  const settled = JSON.parse(remoteGit("show", "main:reminder.json").stdout);
  assert.equal(new Date(settled.lastAskedAt).toISOString(), "2026-10-21T08:00:00.000Z", "the later instant wins even when its string sorts first");
  assert.equal(settled.reason, "asked on one", "the reason comes with its ask");
  assert.equal(new Date(settled.lastAnsweredAt).toISOString(), "2026-10-22T09:00:00.000Z");
  assert.deepEqual(JSON.parse(readFileSync(reminder(two), "utf-8")), settled);
  assert.deepEqual(pushed().slice(0, 2), ["retro: remind answered", "retro: remind answered"]);
  assert.equal(two.git("rev-parse", "HEAD").stdout, remoteGit("rev-parse", "main").stdout);
  assert.equal(JSON.parse(readFileSync(join(two.store, "retro", ".git", "retro-backup.json"), "utf-8")).failure, null);
});

test("after a sync, the secret scan covers exactly the rebased commits the push sends", (t) => {
  const one = sandbox(t);
  const { remote, remoteGit, pushed } = backedUp(t, one.store);
  one.run(["register", A]);
  const two = otherMachine(t, remote);
  assert.equal(two.run(["register", B]).err, "");
  const bin = scratchDir(t);
  const ranges = join(bin, "ranges");
  writeFileSync(join(bin, "gitleaks"), `#!/bin/sh\nwhile [ $# -gt 0 ] && [ "$1" != "--log-opts" ]; do shift; done\necho "$2" >> ${ranges}\nexit 0\n`, { mode: 0o755 });
  const recording = { PATH: `${bin}:${process.env.PATH}` };
  const leaked = () => remoteGit("log", "-p", "--text", "main").stdout.includes("BEGIN OPENSSH");

  assert.equal(one.run(["register", C]).err, "");
  writeFileSync(join(two.home(B), "notes.md"), `context\n${FAKE_KEY}`);
  const blocked = two.run(["register", B], undefined, recording);
  assert.match(blocked.err, new RegExp(`possible secret in ${join(two.home(B), "notes.md")}`));
  assert.equal(pushed()[0], `retro: register ${C}`);
  assert.ok(!leaked());
  const blockedRange = readFileSync(ranges, "utf-8").trim().split("\n").at(-1);
  assert.equal(blockedRange, `${two.git("rev-parse", "HEAD").stdout.trim()} --not --remotes=origin`, "the scan read the commit as rebased");
  assert.equal(two.git("merge-base", "--is-ancestor", "@{u}", "HEAD").status, 0);

  writeFileSync(join(two.home(B), "notes.md"), "context\n");
  assert.equal(one.run(["register", A, "--title", "meanwhile"]).err, "");
  assert.equal(two.run(["register", B, "--title", "clean"], undefined, recording).err, "");
  const sent = remoteGit("rev-parse", "main").stdout.trim();
  assert.equal(readFileSync(ranges, "utf-8").trim().split("\n").at(-1), `${sent} --not --remotes=origin`, "the scan read the very commit that was pushed");
  assert.deepEqual(pushed().slice(0, 3), [`retro: register ${B}`, `retro: register ${A}`, `retro: register ${C}`]);
  assert.ok(!leaked(), "the held-back commit never reaches the remote");
});

// A PATH with git and flock but no gitleaks, and a HOME with no installed scanner.
function noScanner(t) {
  const bin = scratchDir(t);
  for (const tool of ["git", "flock"]) symlinkSync(spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).stdout.trim(), join(bin, tool));
  return { PATH: bin, HOME: scratchDir(t) };
}

function fakeScanner(path, exitCode = 0) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n: > "$0.ran"\nexit ${exitCode}\n`, { mode: 0o755 });
}

test("without gitleaks anywhere nothing is pushed, and REGISTRY.md says where it looked", (t) => {
  const { store, run } = sandbox(t);
  const { pushed } = backedUp(t, store);
  const env = noScanner(t);
  const r = run(["register", A], undefined, env);
  assert.equal(r.code, 0, "the record is still written");
  const looked = `gitleaks not found in \\$GITLEAKS_PATH, on PATH, or at ${join(env.HOME, "lim", "service", "gitleaks")}/\\*/bin/gitleaks`;
  assert.match(r.err, new RegExp(`backup scan failed \\(${looked}`));
  assert.deepEqual(pushed(), []);
  assert.match(readFileSync(join(store, "retro", "REGISTRY.md"), "utf-8"), new RegExp(`## Not backed up: the last backup failed\n\nscan failed at .*${looked}`));

  assert.equal(run(["register", B]).err, "");
  assert.deepEqual(pushed(), [`retro: register ${B}`, `retro: register ${A}`]);
  assert.doesNotMatch(readFileSync(join(store, "retro", "REGISTRY.md"), "utf-8"), /Not backed up/);
});

test("GITLEAKS_PATH names the scanner when gitleaks is not on PATH", (t) => {
  const { store, run } = sandbox(t);
  const { pushed } = backedUp(t, store);
  const scanner = join(scratchDir(t), "gitleaks-custom");
  fakeScanner(scanner);
  assert.equal(run(["register", A], undefined, { ...noScanner(t), GITLEAKS_PATH: scanner }).err, "");
  assert.ok(existsSync(`${scanner}.ran`), "the named scanner ran");
  assert.deepEqual(pushed(), [`retro: register ${A}`]);
});

test("a GITLEAKS_PATH that does not run fails closed instead of falling back", (t) => {
  const { store, run } = sandbox(t);
  const { pushed } = backedUp(t, store);
  const missing = join(scratchDir(t), "no-such-gitleaks");
  const r = run(["register", A], undefined, { GITLEAKS_PATH: missing });
  assert.match(r.err, new RegExp(`backup scan failed \\(GITLEAKS_PATH=${missing} does not run`));
  assert.deepEqual(pushed(), []);
});

test("with no GITLEAKS_PATH and none on PATH, the newest ~/lim/service/gitleaks install scans", (t) => {
  const { store, run } = sandbox(t);
  const { pushed } = backedUp(t, store);
  const env = noScanner(t);
  const install = (version) => join(env.HOME, "lim", "service", "gitleaks", version, "bin", "gitleaks");
  fakeScanner(install("8.9.0"), 1);
  fakeScanner(install("8.30.1"));
  assert.equal(run(["register", A], undefined, env).err, "");
  assert.ok(existsSync(`${install("8.30.1")}.ran`), "8.30.1 is newer than 8.9.0");
  assert.ok(!existsSync(`${install("8.9.0")}.ran`));
  assert.deepEqual(pushed(), [`retro: register ${A}`]);
});

test("register keeps every model a thread ran on, in the order recorded", (t) => {
  const { run, record, store } = sandbox(t);
  assert.equal(run(["register", A, "--model", "claudeAgent/claude-opus-5-5@run-1"]).code, 0);
  assert.equal(run(["register", A, "--model", "claudeAgent/claude-fable-5-1@run-212", "--model", "claudeAgent/claude-opus-5-5@run-1"]).code, 0);
  assert.equal(run(["register", A, "--model", "codex/gpt-6.1-sol@2026-10-19"]).code, 0);
  assert.deepEqual(
    record(A).models.map(({ provider, model, from }) => `${provider}/${model}@${from}`),
    ["claudeAgent/claude-opus-5-5@run-1", "claudeAgent/claude-fable-5-1@run-212", "codex/gpt-6.1-sol@2026-10-19"],
  );
  assert.match(readFileSync(join(store, "retro", "REGISTRY.md"), "utf-8"), /claudeAgent\/claude-opus-5-5 from run-1<br>claudeAgent\/claude-fable-5-1 from run-212<br>codex\/gpt-6.1-sol from 2026-10-19/);
  const bad = run(["register", A, "--model", "claude-opus-5-5"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /--model takes <provider>\/<model>@<from>/);
});

test("registers a delegated child's thread id", (t) => {
  const { run, home } = sandbox(t);
  const child = "thread:delegated-task:command%3Amcp%3A08c364f5-0c24-4c5a-bcb9-d058b5f7686c%3Adelegate-task%3Aslice-lane-7";
  assert.equal(run(["register", child, "--title", "lane 7", "--project", "dungeonwright"]).code, 0);
  assert.ok(existsSync(join(home(child), "thread.json")));
  for (const key of ["review~r1", "review-v1.", "a(b)!*'c"]) {
    const id = `thread:delegated-task:command%3Amcp%3A08c364f5-0c24-4c5a-bcb9-d058b5f7686c%3Adelegate-task%3A${encodeURIComponent(key)}`;
    assert.equal(run(["register", id]).code, 0, key);
  }
  const paren = "thread:delegated-task:command%3Amcp%3A08c364f5-0c24-4c5a-bcb9-d058b5f7686c%3Adelegate-task%3Areview)r1";
  run(["register", paren, "--title", "paren"]);
  assert.ok(run(["status"]).out.includes(`[paren](<t3-thread://v1/${paren}>)`));
  assert.match(run(["status"]).out, /lane 7/);
});

function absolutize(file, retro) {
  const rec = JSON.parse(readFileSync(file, "utf-8"));
  const abs = (p) => (isAbsolute(p) ? p : join(retro, p));
  if (file.endsWith("thread.json")) {
    rec.reflects = rec.reflects.map((c) => ({ ...c, dir: abs(c.dir) }));
    rec.trails = rec.trails.map((x) => ({ ...x, source: abs(x.source), path: abs(x.path) }));
  } else {
    rec.reflects = rec.reflects.map(abs);
    rec.inputs = rec.inputs.map((x) => ({ ...x, source: abs(x.source), copy: abs(x.copy) }));
  }
  writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
}

test("paths inside the retro folder are stored relative to it, so another machine's store reads them", (t) => {
  const { store, run, record, reflect } = sandbox(t, { underHome: true });
  const trail = join(scratchDir(t), "decisions.tsv");
  writeFileSync(trail, "row\n");
  const dir = reflect(A, "2026-10-20T09:00:00Z", { "backlog.md": "- a script for X\n" });
  run(["register", A, "--trail", trail], "2026-10-20T09:00:00Z");
  const rec = record(A);
  assert.equal(rec.reflects[0].dir, relative(join(store, "retro"), dir));
  assert.ok(rec.trails[0].path.startsWith(`${A}/trails/`), rec.trails[0].path);
  assert.equal(rec.trails[0].source, trail, "a path outside the retro folder stays absolute");
  const lookalike = join(scratchDir(t), "retro", A, "notes.md");
  mkdirSync(dirname(lookalike), { recursive: true });
  writeFileSync(lookalike, "n\n");
  run(["register", A, "--trail", lookalike], "2026-10-20T09:00:00Z");
  run(["register", A, "--trail", lookalike], "2026-10-20T09:00:00Z");
  assert.deepEqual(record(A).trails.map((x) => x.source), [trail, lookalike], "a project's own retro folder is not the store's, so an unchanged trail keeps one copy");

  const other = sandbox(t);
  cpSync(join(store, "retro"), join(other.store, "retro"), { recursive: true });
  const status = other.run(["status"], "2026-10-20T10:00:00Z").out;
  assert.ok(status.includes(other.inRetro(rec.reflects[0].dir)), "the reflect reads under this machine's store");
  assert.ok(status.includes(other.inRetro(rec.trails[0].path)));
  assert.doesNotMatch(status, /## Problems/);
  assert.match(other.run(["backlog"]).out, /a script for X/);
  assert.equal(other.run(["open", "--at", "2026-10-20"]).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(other.inRetro("rounds/2026-10-20/round.json"), "utf-8")).reflects, [rec.reflects[0].dir]);
});

test("records saved with absolute paths, here or on a Mac, read the same before and after migrate-paths, which runs once", (t) => {
  const { store, run, home, inRetro, reflect, closeRound } = sandbox(t, { underHome: true });
  const { pushed } = backedUp(t, store);
  const mac = "/Users/leemoore/.local/state/pstack/retro";
  const idOutsideThreadPattern = "limhealth-2026-10-16";
  const folderOutsideThreadPattern = inRetro("limhealth-restart-2026-10-16");
  mkdirSync(folderOutsideThreadPattern);
  writeFileSync(join(folderOutsideThreadPattern, "notes.md"), "n\n");
  const trail = join(scratchDir(t), "decisions.tsv");
  writeFileSync(trail, "row\n");
  reflect(A, "2026-10-19T09:00:00Z");
  run(["open", "--threads", A, "--input", folderOutsideThreadPattern, "--at", "2026-10-19"], "2026-10-19T10:00:00Z");
  closeRound("2026-10-19", "2026-10-19T11:00:00Z");
  reflect(B, "2026-10-20T09:00:00Z");
  run(["register", B, "--trail", trail], "2026-10-20T09:00:00Z");
  mkdirSync(inRetro(`${idOutsideThreadPattern}/reflect-1`), { recursive: true });
  writeFileSync(inRetro(`${idOutsideThreadPattern}/reflect-1/synthesis.md`), "findings\n");
  writeFileSync(inRetro(`${idOutsideThreadPattern}/reflect-1/backlog.md`), "- from the Mac\n");
  const at = "2026-10-16T09:00:00Z";
  writeFileSync(
    inRetro(`${idOutsideThreadPattern}/thread.json`),
    JSON.stringify({ thread: idOutsideThreadPattern, title: "legacy", project: null, firstRegistered: at, lastRegistered: at, reflects: [{ dir: "reflect-1", completedAt: at }], trails: [] }),
  );
  absolutize(inRetro(`${idOutsideThreadPattern}/thread.json`), join(mac, idOutsideThreadPattern));
  absolutize(join(home(A), "thread.json"), mac);
  absolutize(inRetro("rounds/2026-10-19/round.json"), mac);
  absolutize(join(home(B), "thread.json"), join(store, "retro"));
  const records = [join(home(A), "thread.json"), join(home(B), "thread.json"), inRetro(`${idOutsideThreadPattern}/thread.json`), inRetro("rounds/2026-10-19/round.json")];
  const NOW = "2026-10-21T09:00:00Z";

  const before = run(["status"], NOW).out;
  assert.doesNotMatch(before, /## Problems/);
  assert.doesNotMatch(before, /aaaaaaaa[^\n]*reflect-/, "the Mac's round took A's reflect");
  assert.ok(before.includes(inRetro(`${idOutsideThreadPattern}/reflect-1`)), "the Mac's path reads under this store");
  assert.match(run(["backlog"]).out, /from the Mac/);

  const migrated = run(["migrate-paths"], NOW);
  assert.equal(migrated.code, 0, migrated.err);
  assert.match(migrated.out, /rewrote 4 of 4 records/);
  for (const file of records) {
    const text = readFileSync(file, "utf-8");
    assert.ok(!text.includes(mac) && !text.includes(join(store, "retro")), `${file} holds no absolute retro path`);
  }
  assert.equal(run(["status"], NOW).out, before);
  assert.equal(pushed()[0], "retro: store paths relative to the retro folder in 4 records");

  const texts = records.map((f) => readFileSync(f, "utf-8"));
  const again = run(["migrate-paths"], NOW);
  assert.match(again.out, /already stores paths/);
  assert.deepEqual(records.map((f) => readFileSync(f, "utf-8")), texts);
  assert.equal(pushed()[0], "retro: store paths relative to the retro folder in 4 records", "a second run commits nothing");
});
