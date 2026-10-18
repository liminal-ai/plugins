import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  const run = (args, nowIso) => {
    const env = { ...process.env, PSTACK_STORE: store };
    if (nowIso) env.RETRO_NOW = nowIso;
    else delete env.RETRO_NOW;
    const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf-8", env });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const home = (id) => join(store, "retro", id);
  const reflect = (id, nowIso) => {
    run(["register", id], nowIso);
    writeFileSync(join(home(id), "synthesis.md"), "findings\n");
    return run(["register", id, "--reflected"], nowIso);
  };
  return { store, run, home, reflect };
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

test("--reflected refuses until synthesis.md is written", (t) => {
  const { run, reflect } = sandbox(t);
  const refused = run(["register", A, "--reflected"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /synthesis\.md is missing/);
  assert.equal(reflect(A).code, 0);
  assert.match(run(["status"]).out, /## Waiting for a round\n\n\| thread/);
});

test("rejects an id that is not a thread uuid and an unknown option", (t) => {
  const { run } = sandbox(t);
  assert.match(run(["register", "limhealth-restart"]).err, /needs a T3 thread id/);
  assert.match(run(["register", A, "--titel", "x"]).err, /unknown option --titel/);
});

test("trails in the temp dir are copied, trails in the store are linked", (t) => {
  const { store, run, home } = sandbox(t);
  const scratch = mkdtempSync(join(tmpdir(), "retro-scratch-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  writeFileSync(join(scratch, "decisions.tsv"), "row 1\n");
  mkdirSync(join(store, "audit"), { recursive: true });
  writeFileSync(join(store, "audit", "run.tsv"), "row\n");
  assert.equal(run(["register", A, "--trail", join(scratch, "decisions.tsv"), "--trail", join(store, "audit", "run.tsv")]).code, 0);
  const rec = JSON.parse(readFileSync(join(home(A), "thread.json"), "utf-8"));
  const copied = rec.trails.find((x) => x.mode === "copied");
  assert.equal(copied.path, join(home(A), "trails", "decisions.tsv"));
  assert.equal(readFileSync(copied.path, "utf-8"), "row 1\n");
  assert.equal(rec.trails.find((x) => x.mode === "linked").path, join(store, "audit", "run.tsv"));

  writeFileSync(join(scratch, "decisions.tsv"), "row 1\nrow 2\n");
  run(["register", A, "--trail", join(scratch, "decisions.tsv")]);
  const again = JSON.parse(readFileSync(join(home(A), "thread.json"), "utf-8"));
  assert.equal(again.trails.length, 2, "re-registering a trail replaces its entry");
  assert.equal(readFileSync(copied.path, "utf-8"), "row 1\nrow 2\n", "re-registering refreshes the copy");

  rmSync(join(scratch, "decisions.tsv"));
  const gone = run(["register", A, "--trail", join(scratch, "decisions.tsv")]);
  assert.equal(gone.code, 0, "a vanished source keeps its earlier copy");
  assert.match(gone.err, /keeping the copy/);
  assert.match(run(["register", A, "--trail", join(scratch, "never.tsv")]).err, /trail not found/);
});

test("a committed clean trail is linked; modified or in a linked worktree it is copied", (t) => {
  const { run, home } = sandbox(t);
  const { repo, git } = gitRepo(t);
  const file = join(repo, "decisions.tsv");
  run(["register", A, "--trail", file]);
  let trail = JSON.parse(readFileSync(join(home(A), "thread.json"), "utf-8")).trails[0];
  assert.equal(trail.mode, "linked");
  assert.equal(trail.commit, git("rev-parse", "HEAD").stdout.trim());

  writeFileSync(file, "ts\tphase\nedited\n");
  run(["register", B, "--trail", file]);
  trail = JSON.parse(readFileSync(join(home(B), "thread.json"), "utf-8")).trails[0];
  assert.equal(trail.mode, "copied");

  git("checkout", "-q", "--", "decisions.tsv");
  const wt = `${repo}-wt`;
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  git("worktree", "add", "-q", wt);
  run(["register", C, "--trail", join(wt, "decisions.tsv")]);
  trail = JSON.parse(readFileSync(join(home(C), "thread.json"), "utf-8")).trails[0];
  assert.equal(trail.mode, "copied");
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
  const { store, run, home, reflect } = sandbox(t);
  reflect(A);
  writeFileSync(join(home(A), "backlog.md"), "- a script for X\n");
  reflect(B);
  run(["register", C]);

  const opened = run(["open", "--at", "2026-10-20"]);
  assert.equal(opened.code, 0, opened.err);
  const dir = join(store, "retro", "rounds", "2026-10-20");
  assert.equal(opened.out.trim(), dir);
  const round = JSON.parse(readFileSync(join(dir, "round.json"), "utf-8"));
  assert.deepEqual(round.threads.sort(), [A, B]);
  assert.equal(readFileSync(join(dir, "inputs", A, "synthesis.md"), "utf-8"), "findings\n");
  assert.match(readFileSync(join(dir, "backlog.md"), "utf-8"), /a script for X/);
  assert.match(readFileSync(join(dir, "README.md"), "utf-8"), /merge-gate\.md/);

  assert.match(run(["open", "--threads", C]).err, /round 2026-10-20 is open/);
  assert.match(run(["status"]).out, /Round due: no, round 2026-10-20 has been open/);

  writeFileSync(join(dir, "synthesis.md"), "s\n");
  writeFileSync(join(dir, "decisions.md"), "d\n");
  const early = run(["close", "2026-10-20"]);
  assert.equal(early.code, 1);
  assert.match(early.err, /missing merge-gate\.md/);
  writeFileSync(join(dir, "merge-gate.md"), "m\n");
  assert.equal(run(["close", "2026-10-20"]).code, 0);

  const status = run(["status"]).out;
  assert.match(status, /\| 2026-10-20 \| closed 2026-10-\d\d \|/);
  assert.match(status, /## Waiting for a round\n\nNone\./);
  assert.doesNotMatch(status, /## Problems/);
  assert.match(run(["open", "--threads", A]).err, /was retro'd in round 2026-10-20/);
});

test("a thread that reflects again after its round is waiting again", (t) => {
  const { store, run, reflect } = sandbox(t);
  reflect(A, "2026-10-01T09:00:00Z");
  run(["open"], "2026-10-02T09:00:00Z");
  const dir = join(store, "retro", "rounds", "2026-10-02");
  for (const f of ["synthesis.md", "decisions.md", "merge-gate.md"]) writeFileSync(join(dir, f), "x\n");
  run(["close", "2026-10-02"], "2026-10-02T10:00:00Z");
  assert.match(run(["status"], "2026-10-03T09:00:00Z").out, /no reflects waiting/);
  reflect(A, "2026-10-04T09:00:00Z");
  assert.match(run(["status"], "2026-10-04T10:00:00Z").out, /1 reflect waiting/);
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

test("backlog gathers each waiting thread's backlog under its heading", (t) => {
  const { run, home, reflect } = sandbox(t);
  reflect(A);
  run(["register", A, "--title", "first"]);
  writeFileSync(join(home(A), "backlog.md"), "- item one\n");
  reflect(B);
  const out = run(["backlog"]).out;
  assert.match(out, /## \[first\]\(t3-thread:\/\/v1\/aaaaaaaa[^\n]*\n\n- item one/);
  assert.ok(!existsSync(join(home(B), "backlog.md")));
});
