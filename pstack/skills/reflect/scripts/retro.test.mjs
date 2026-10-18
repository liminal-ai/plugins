import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "retro.mjs");
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";

function sandbox(t) {
  const store = mkdtempSync(join(tmpdir(), "retro-store-"));
  t.after(() => rmSync(store, { recursive: true, force: true }));
  const env = (nowIso, extra = {}) => {
    const e = { ...process.env, PSTACK_STORE: store, ...extra };
    if (nowIso) e.RETRO_NOW = nowIso;
    else delete e.RETRO_NOW;
    return e;
  };
  const run = (args, nowIso, extra) => {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf-8", env: env(nowIso, extra) });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const home = (id) => join(store, "retro", id);
  const record = (id) => JSON.parse(readFileSync(join(home(id), "thread.json"), "utf-8"));
  const reflect = (id, nowIso, files = {}) => {
    const dir = run(["reflect", id], nowIso).out.trim();
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
  return { store, run, home, record, reflect, closeRound, env };
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
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "decisions.tsv"), "ts\tphase\n");
  git("add", ".");
  git("commit", "-qm", "trail");
  return { repo, git };
}

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
  const { store, run, record } = sandbox(t);
  const scratch = scratchDir(t);
  const file = join(scratch, "review.md");
  writeFileSync(file, "first flags\n");
  mkdirSync(join(store, "audit"), { recursive: true });
  writeFileSync(join(store, "audit", "run.tsv"), "row\n");
  run(["register", A, "--trail", file, "--trail", join(store, "audit", "run.tsv")], "2026-10-01T09:00:00Z");
  run(["register", A, "--trail", file], "2026-10-01T10:00:00Z");
  assert.equal(record(A).trails.length, 2, "unchanged source makes no new version");
  assert.equal(record(A).trails.find((x) => x.mode === "linked").path, join(store, "audit", "run.tsv"));

  writeFileSync(file, "replacement flags\n");
  run(["register", A, "--trail", file], "2026-10-01T11:00:00Z");
  const copies = record(A).trails.filter((x) => x.mode === "copied");
  assert.equal(copies.length, 2);
  assert.equal(readFileSync(copies[0].path, "utf-8"), "first flags\n");
  assert.equal(readFileSync(copies[1].path, "utf-8"), "replacement flags\n");
  assert.ok(run(["status"]).out.includes(copies[1].path), "status shows the newest version");

  rmSync(file);
  const gone = run(["register", A, "--trail", file]);
  assert.equal(gone.code, 0, "a vanished source keeps its last copy");
  assert.match(gone.err, /keeping the copy/);
  assert.match(run(["register", A, "--trail", join(scratch, "never.tsv")]).err, /trail not found/);
});

test("symlinked trails are materialized or linked by their real target", (t) => {
  const { store, run, record } = sandbox(t);
  const scratch = scratchDir(t);
  writeFileSync(join(scratch, "evidence.md"), "e\n");
  mkdirSync(join(scratch, "alias"));
  symlinkSync(join(scratch, "evidence.md"), join(scratch, "alias", "evidence.md"));
  mkdirSync(join(store, "audit"), { recursive: true });
  symlinkSync(join(scratch, "evidence.md"), join(store, "audit", "points-out.md"));
  writeFileSync(join(store, "audit", "real.tsv"), "row\n");
  symlinkSync(join(store, "audit", "real.tsv"), join(scratch, "alias-to-store.tsv"));

  run(["register", A, "--trail", join(scratch, "alias"), "--trail", join(store, "audit", "points-out.md"), "--trail", join(scratch, "alias-to-store.tsv")]);
  const trails = record(A).trails;
  rmSync(join(scratch, "evidence.md"));
  rmSync(join(scratch, "alias-to-store.tsv"));
  for (const x of trails.filter((x) => x.mode === "copied")) {
    const files = lstatSync(x.path).isDirectory() ? readdirSync(x.path).map((n) => join(x.path, n)) : [x.path];
    for (const f of files) assert.equal(readFileSync(f, "utf-8"), "e\n", `${f} survives its source`);
  }
  assert.equal(trails.filter((x) => x.mode === "copied").length, 2);
  assert.equal(trails.find((x) => x.mode === "linked").path, join(store, "audit", "real.tsv"));
});

test("a committed clean trail is linked; modified or in a linked worktree it is copied", (t) => {
  const { run, record } = sandbox(t);
  const { repo, git } = gitRepo(t);
  const file = join(repo, "decisions.tsv");
  run(["register", A, "--trail", file]);
  assert.equal(record(A).trails[0].mode, "linked");
  assert.equal(record(A).trails[0].commit, git("rev-parse", "HEAD").stdout.trim());

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
  assert.ok(round.reflects.includes(dirA));
  assert.equal(readFileSync(join(dir, "inputs", A, dirA.split("/").at(-1), "synthesis.md"), "utf-8"), "findings\n");
  assert.match(readFileSync(join(dir, "backlog.md"), "utf-8"), /a script for X/);
  assert.match(readFileSync(join(dir, "README.md"), "utf-8"), /merge-gate\.md/);

  assert.match(run(["open", "--threads", C]).err, /round 2026-10-20 is open/);
  assert.match(run(["status"]).out, /Round due: no, round 2026-10-20 has been open/);

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

test("backlog gathers each waiting reflect's backlog under its thread", (t) => {
  const { run, reflect } = sandbox(t);
  run(["register", A, "--title", "first"]);
  reflect(A, undefined, { "backlog.md": "- item one\n" });
  reflect(B);
  const out = run(["backlog"]).out;
  assert.match(out, /## \[first\]\(t3-thread:\/\/v1\/aaaaaaaa[^\n]*\n\n- item one/);
  assert.doesNotMatch(out, /bbbbbbbb/);
});
