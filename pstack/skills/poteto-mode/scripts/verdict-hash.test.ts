import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";

const script = join(import.meta.dir, "verdict-hash.sh");
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo() {
	const root = mkdtempSync(join(tmpdir(), "verdict-hash-"));
	roots.push(root);
	const git = (...args: string[]) => {
		const run = spawnSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd: root, encoding: "utf-8" });
		if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
		return run.stdout.trim();
	};
	const write = (path: string, text: string) => {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text);
	};
	git("init", "-q", "-b", "main");
	write("m.py", "def f():\n    return 1\n\ndef f():\n    return 1\n");
	write("x.bin", "a111\n");
	write("d/keep", "k\n");
	git("add", "-A");
	git("commit", "-qm", "base");
	const branch = (name: string, change: () => void) => {
		git("checkout", "-q", "-b", name, "main");
		change();
		git("add", "-A");
		git("commit", "-qm", name);
		git("checkout", "-q", "main");
		return git("rev-parse", name);
	};
	const hash = (base: string, head: string, cwd = root) =>
		spawnSync("bash", [script, base, head], { cwd, encoding: "utf-8" });
	return { root, git, write, branch, hash, base: git("rev-parse", "main") };
}

test("a change moved between identical blocks hashes differently", () => {
	const r = repo();
	const first = r.branch("first", () => r.write("m.py", "def f():\n    return 2\n\ndef f():\n    return 1\n"));
	const second = r.branch("second", () => r.write("m.py", "def f():\n    return 1\n\ndef f():\n    return 2\n"));
	expect(r.hash(r.base, first).stdout).not.toBe(r.hash(r.base, second).stdout);
});

test("textconv and diff.relative config cannot hide a change", () => {
	const r = repo();
	r.write(".gitattributes", "*.bin diff=first\n");
	r.git("add", ".gitattributes");
	r.git("commit", "-qm", "attrs");
	const base = r.git("rev-parse", "HEAD");
	const one = r.branch("one", () => r.write("x.bin", "a222\n"));
	const two = r.branch("two", () => r.write("x.bin", "a333\n"));
	r.git("config", "diff.first.textconv", "head -c 1");
	r.git("config", "diff.relative", "true");
	const inSubdir = join(r.root, "d");
	expect(r.hash(base, one, inSubdir).stdout).not.toBe(r.hash(base, two, inSubdir).stdout);
});

test("a replace ref cannot make one head read as another", () => {
	const r = repo();
	const one = r.branch("one", () => r.write("x.bin", "one\n"));
	const two = r.branch("two", () => r.write("x.bin", "two\n"));
	r.git("replace", two, one);
	expect(r.hash(r.base, one).stdout).not.toBe(r.hash(r.base, two).stdout);
});

test("a git failure exits non-zero and prints no hash", () => {
	const r = repo();
	const one = r.branch("one", () => r.write("x.bin", "one\n"));
	r.git("config", "core.abbrev", "invalid-value");
	const run = r.hash(r.base, one);
	expect(run.status).not.toBe(0);
	expect(run.stdout).toBe("");
});

test("an empty change and an unknown commit are refused", () => {
	const r = repo();
	expect(r.hash(r.base, r.base).status).not.toBe(0);
	expect(r.hash(r.base, "0".repeat(40)).status).not.toBe(0);
});

test("a rebase over an unrelated trunk change keeps the hash", () => {
	const r = repo();
	const head = r.branch("pr", () => r.write("x.bin", "pr\n"));
	const before = r.hash(r.base, head).stdout;
	r.write("other.txt", "trunk\n");
	r.git("add", "other.txt");
	r.git("commit", "-qm", "trunk");
	r.git("checkout", "-q", "pr");
	r.git("rebase", "-q", "main");
	const rebased = r.git("rev-parse", "HEAD");
	const mergeBase = r.git("merge-base", "main", rebased);
	expect(r.hash(mergeBase, rebased).stdout).toBe(before);
	expect(before).toMatch(/^[0-9a-f]{64}\n$/);
});
