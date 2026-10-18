import { afterAll, beforeAll, expect, it } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.ts";
import { type Repos, makeRepos, runtimeFor } from "./fakes.test-helper.ts";
import { GhGitHub } from "./github.ts";

const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\0' "$@" > "$FAKE_GH_DIR/calls/$(date +%s%N)"
case "$*" in
  "repo view"*) cat "$FAKE_GH_DIR/repo.json" ;;
  "pr view"*"state,mergedAt,baseRefName,mergeCommit"*) cat "$FAKE_GH_DIR/readback.json" ;;
  "pr view"*) cat "$FAKE_GH_DIR/pr.json" ;;
  "pr merge"*) ;;
  "api --paginate"*) cat "$FAKE_GH_DIR/comments.json" ;;
  *HeadChecks*) cat "$FAKE_GH_DIR/checks.json" ;;
  *OpenThreads*) cat "$FAKE_GH_DIR/threads.json" ;;
  *) echo "unexpected gh call: $*" >&2; exit 9 ;;
esac
`;

let repos: Repos;
let dir: string;
const saved = { PATH: process.env.PATH, FAKE_GH_DIR: process.env.FAKE_GH_DIR };

beforeAll(() => {
  repos = makeRepos();
  dir = mkdtempSync(join(tmpdir(), "merge-gate-gh-"));
  const bin = join(dir, "bin");
  for (const sub of ["bin", "calls"])
    Bun.spawnSync(["mkdir", "-p", join(dir, sub)]);
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  const json = (name: string, value: unknown) =>
    writeFileSync(join(dir, name), JSON.stringify(value));
  json("repo.json", { defaultBranchRef: { name: "main" } });
  json("pr.json", {
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "",
    headRefOid: repos.head,
    headRefName: "feature",
    baseRefName: "main",
    state: "OPEN",
    mergedAt: null,
    isDraft: false,
  });
  const user = (login: string, type: string) => ({ login, type });
  json("comments.json", [
    [
      {
        user: user("leegmoore", "User"),
        body: `pstack-verdict: PASS head=${repos.head} base=${repos.main} by=codex/gpt-6.1-sol`,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        html_url: "https://github.com/owner/repo/pull/1#issuecomment-1",
      },
    ],
    [
      {
        user: user("chatgpt-codex-connector[bot]", "Bot"),
        body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${repos.head}","status":"completed"}} -->`,
        created_at: "2026-01-01T00:00:01Z",
        updated_at: "2026-01-01T00:00:01Z",
        html_url: "https://github.com/owner/repo/pull/1#issuecomment-2",
      },
    ],
  ]);
  json("checks.json", {
    data: {
      repository: {
        object: {
          statusCheckRollup: {
            contexts: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  __typename: "CheckRun",
                  name: "ci",
                  status: "COMPLETED",
                  conclusion: "SUCCESS",
                  detailsUrl: "",
                },
                {
                  __typename: "CheckRun",
                  name: "Cursor Bugbot",
                  status: "QUEUED",
                  conclusion: null,
                  detailsUrl: "",
                },
                {
                  __typename: "StatusContext",
                  context: "deploy",
                  state: "SUCCESS",
                  targetUrl: "",
                },
              ],
            },
          },
        },
      },
    },
  });
  json("threads.json", {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                isResolved: true,
                path: "a.txt",
                line: 1,
                comments: {
                  nodes: [{ body: "done", url: "u", author: { login: "x" } }],
                },
              },
            ],
          },
        },
      },
    },
  });
  json("readback.json", {
    state: "MERGED",
    mergedAt: "2026-01-01T00:00:00Z",
    baseRefName: "main",
    mergeCommit: { oid: "a".repeat(40) },
  });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_GH_DIR = dir;
});

afterAll(() => {
  process.env.PATH = saved.PATH;
  if (saved.FAKE_GH_DIR === undefined) delete process.env.FAKE_GH_DIR;
  else process.env.FAKE_GH_DIR = saved.FAKE_GH_DIR;
});

it("reads and merges through gh, naming the repo on every call", async () => {
  const runtime = runtimeFor(new GhGitHub(), repos.gate);
  const exit = await main(["--repo", "owner/repo", "--pr", "1"], runtime);
  expect(runtime.out().split("\n")[0]).toBe(
    `MERGED: owner/repo#1 at ${repos.head.slice(0, 7)} into main as aaaaaaa`
  );
  expect(exit).toBe(0);

  const calls = readdirSync(join(dir, "calls"))
    .sort()
    .map((name) =>
      readFileSync(join(dir, "calls", name), "utf8")
        .split("\0")
        .slice(0, -1)
    );
  expect(calls.length).toBe(7);
  for (const argv of calls) {
    const names = argv.includes("--repo")
      ? argv[argv.indexOf("--repo") + 1] === "owner/repo"
      : argv[0] === "repo"
        ? argv[2] === "owner/repo"
        : argv.includes("graphql")
          ? argv.includes("owner=owner") && argv.includes("repo=repo")
          : argv.some((arg) => arg.startsWith("repos/owner/repo/"));
    expect({ argv, names }).toEqual({ argv, names: true });
  }
  expect(calls).toContainEqual([
    "pr",
    "merge",
    "1",
    "--repo",
    "owner/repo",
    "--squash",
    "--match-head-commit",
    repos.head,
  ]);
});
