import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseRemote } from "../watch-pr/github.ts";
import type { Repository } from "../watch-pr/types.ts";
import type { HashResult } from "./gate.ts";

const VERDICT_HASH = join(import.meta.dir, "..", "verdict-hash.sh");

export class ReadError extends Error {
  override readonly name = "ReadError";
}

interface Output {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const sameRepo = (a: Repository, b: Repository): boolean =>
  a.owner.toLowerCase() === b.owner.toLowerCase() &&
  a.repo.toLowerCase() === b.repo.toLowerCase();

/** Git in one clone. Every read that can fail closed throws ReadError. */
export class Git {
  constructor(readonly cwd: string) {}

  private exec(
    argv: readonly string[],
    env: Record<string, string> = {}
  ): Output {
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd: this.cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_TERMINAL_PROMPT: "0",
        ...env,
      },
    });
    if (result.error)
      throw new ReadError(`${argv.join(" ")}: ${result.error.message}`);
    return {
      code: result.status ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  private git(args: readonly string[], env?: Record<string, string>): string {
    const result = this.exec(["git", ...args], env);
    if (result.code !== 0)
      throw new ReadError(
        `git ${args.join(" ")} failed: ${result.stderr.trim().split("\n")[0] ?? ""}`
      );
    return result.stdout;
  }

  originRepo(): Repository {
    const url = this.exec(["git", "config", "--get", "remote.origin.url"]);
    const repo = url.code === 0 ? parseRemote(url.stdout) : null;
    if (repo === null)
      throw new ReadError(
        `the origin remote in ${this.cwd} is not a GitHub repo. Pass --repo <owner/name>.`
      );
    return repo;
  }

  /** The remote whose configured URL names the repo, read raw so the test can redirect it with insteadOf. */
  remoteFor(repo: Repository): string {
    const listed = this.exec([
      "git",
      "config",
      "--get-regexp",
      "^remote\\..*\\.url$",
    ]);
    for (const entry of listed.stdout.split("\n")) {
      const match = /^remote\.(.+)\.url (.+)$/.exec(entry.trim());
      const parsed = match === null ? null : parseRemote(match[2]);
      if (match !== null && parsed !== null && sameRepo(parsed, repo))
        return match[1];
    }
    throw new ReadError(
      `no git remote in ${this.cwd} points at ${repo.owner}/${repo.repo}. Run the gate from a clone of that repo.`
    );
  }

  branchTip(remote: string, branch: string): string {
    const line =
      this.git(["ls-remote", remote, `refs/heads/${branch}`]).split("\n")[0] ??
      "";
    const sha = line.split("\t")[0] ?? "";
    if (!/^[0-9a-f]{40}$/.test(sha))
      throw new ReadError(`branch ${branch} was not found on remote ${remote}`);
    return sha;
  }

  /** Fetches commits by SHA. GitHub serves any commit in the repo this way, including ones a force-push left behind. */
  fetch(remote: string, shas: readonly string[]): void {
    const absent = shas.filter(
      (sha) =>
        this.exec(["git", "cat-file", "-e", `${sha}^{commit}`]).code !== 0
    );
    if (absent.length === 0) return;
    this.git([
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      remote,
      ...new Set(absent),
    ]);
  }

  mergeBase(a: string, b: string): string {
    return this.git(["merge-base", a, b]).trim();
  }

  verdictHash(base: string, head: string): HashResult {
    const result = this.exec([VERDICT_HASH, base, head]);
    const hash = result.stdout.trim();
    if (result.code === 0 && /^[0-9a-f]{64}$/.test(hash))
      return { ok: true, hash };
    return {
      ok: false,
      detail:
        result.stderr.trim().split("\n")[0] ||
        `verdict-hash.sh exited ${result.code}`,
    };
  }

  changedPaths(base: string, head: string): string[] {
    return this.git([
      "diff-tree",
      "-r",
      "--no-renames",
      "--name-only",
      "-z",
      base,
      head,
    ])
      .split("\0")
      .filter((path) => path !== "");
  }

  /** sha256 of `git diff-tree -r --no-renames --full-index --abbrev=40 <base> <head> -- <paths>`. */
  diffHash(base: string, head: string, paths: readonly string[]): string {
    const diff = this.git(
      [
        "diff-tree",
        "-r",
        "--no-renames",
        "--full-index",
        "--abbrev=40",
        base,
        head,
        "--",
        ...paths,
      ],
      { GIT_LITERAL_PATHSPECS: "1" }
    );
    return createHash("sha256").update(diff).digest("hex");
  }
}
