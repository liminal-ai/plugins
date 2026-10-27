import { afterAll, beforeAll, expect, it } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.ts";
import { type Repos, makeRepos, runtimeFor } from "./fakes.test-helper.ts";
import { GhGitHub } from "./github.ts";
import { parsePrNumber } from "../watch-pr/types.ts";

const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\0' "$@" > "$FAKE_GH_DIR/calls/$(date +%s%N)"
case "$*" in
  "repo view"*) cat "$FAKE_GH_DIR/repo.json" ;;
  "pr view"*"state,mergedAt,baseRefName,mergeCommit"*) cat "$FAKE_GH_DIR/readback.json" ;;
  "pr view"*) cat "$FAKE_GH_DIR/pr.json" ;;
  "pr merge"*) ;;
  "pr comment"*) ;;
  *"repos/broken/repo/contents/"*) echo "gh: Server Error (HTTP 502)" >&2; exit 1 ;;
  *"contents/.agents/merge-brief.md")
    if [ -f "$FAKE_GH_DIR/merge-brief.md" ]; then cat "$FAKE_GH_DIR/merge-brief.md"
    else echo '{"message":"Not Found"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi ;;
  "api --paginate"*) cat "$FAKE_GH_DIR/comments.json" ;;
  *HeadChecks*) cat "$FAKE_GH_DIR/checks.json" ;;
  *OpenThreads*) cat "$FAKE_GH_DIR/threads.json" ;;
  *MergeQueue*) cat "$FAKE_GH_DIR/queue.json" ;;
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
  json("queue.json", { data: { repository: { mergeQueue: null } } });
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
    autoMergeRequest: null,
  });
  const user = (login: string, type: string) => ({ login, type });
  json("comments.json", [
    [
      {
        id: 1,
        user: user("leegmoore", "User"),
        body: `pstack-verdict: PASS head=${repos.head} base=${repos.main} by=codex/gpt-6.1-sol`,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        html_url: "https://github.com/owner/repo/pull/1#issuecomment-1",
        author_association: "MEMBER",
      },
    ],
    [
      {
        id: 2,
        user: user("chatgpt-codex-connector[bot]", "Bot"),
        body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${repos.head}","status":"completed"}} -->`,
        created_at: "2026-01-01T00:00:01Z",
        updated_at: "2026-01-01T00:00:01Z",
        html_url: "https://github.com/owner/repo/pull/1#issuecomment-2",
        author_association: "NONE",
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
                  checkSuite: {
                    app: { slug: "github-actions" },
                    workflowRun: {
                      id: "R_1",
                      event: "pull_request",
                      workflow: { id: "W_ci" },
                    },
                  },
                },
                {
                  __typename: "CheckRun",
                  name: "Cursor Bugbot",
                  status: "QUEUED",
                  conclusion: null,
                  detailsUrl: "",
                  checkSuite: { app: { slug: "cursor" }, workflowRun: null },
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
  expect(runtime.decision().split("\n")[0]).toBe(
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
  expect(calls.length).toBe(15);
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

it("passes --method merge to gh pr merge with the pinned head", async () => {
  const before = new Set(readdirSync(join(dir, "calls")));
  const runtime = runtimeFor(new GhGitHub(), repos.gate);
  const exit = await main(
    ["--repo", "owner/repo", "--pr", "1", "--method", "merge"],
    runtime
  );
  expect(exit).toBe(0);
  const merges = readdirSync(join(dir, "calls"))
    .filter((name) => !before.has(name))
    .map((name) =>
      readFileSync(join(dir, "calls", name), "utf8")
        .split("\0")
        .slice(0, -1)
    )
    .filter((argv) => argv[1] === "merge");
  expect(merges).toEqual([
    [
      "pr",
      "merge",
      "1",
      "--repo",
      "owner/repo",
      "--merge",
      "--match-head-commit",
      repos.head,
    ],
  ]);
});

it("posts the lead's waivers with gh pr comment naming the repo", async () => {
  const before = new Set(readdirSync(join(dir, "calls")));
  const attempt = await new GhGitHub().comment(
    { owner: "owner", repo: "repo", number: parsePrNumber(1) },
    "merge-gate: waived\n\n- perf: covered by GC4"
  );
  expect(attempt).toEqual({ ok: true });
  const posts = readdirSync(join(dir, "calls"))
    .filter((name) => !before.has(name))
    .map((name) =>
      readFileSync(join(dir, "calls", name), "utf8").split("\0").slice(0, -1)
    );
  expect(posts).toEqual([
    [
      "pr",
      "comment",
      "1",
      "--repo",
      "owner/repo",
      "--body",
      "merge-gate: waived\n\n- perf: covered by GC4",
    ],
  ]);
});

async function checkWith(name: string, value: unknown) {
  const path = join(dir, name);
  const saved = readFileSync(path, "utf8");
  writeFileSync(path, JSON.stringify(value));
  try {
    const runtime = runtimeFor(new GhGitHub(), repos.gate);
    const exit = await main(["--repo", "owner/repo", "--pr", "1"], runtime);
    return { exit, out: runtime.decision() };
  } finally {
    writeFileSync(path, saved);
  }
}

const checksPage = (commit: unknown) => ({
  data: { repository: { object: commit } },
});
const threadsPage = (pageInfo: unknown) => ({
  data: {
    repository: { pullRequest: { reviewThreads: { pageInfo, nodes: [] } } },
  },
});
const commentPage = (fields: Record<string, unknown>) => [
  [
    {
      id: 9,
      user: { login: "someone", type: "User" },
      body: "hello",
      created_at: "2026-01-01T00:00:09Z",
      updated_at: "2026-01-01T00:00:09Z",
      html_url: "https://github.com/owner/repo/pull/1#issuecomment-9",
      ...fields,
    },
  ],
];
const onlyCheck = (node: unknown) =>
  checksPage({
    statusCheckRollup: {
      contexts: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [node],
      },
    },
  });
const pull = () => JSON.parse(readFileSync(join(dir, "pr.json"), "utf8"));
const contexts = (pageInfo: unknown) => ({
  statusCheckRollup: { contexts: { pageInfo, nodes: [] } },
});

for (const [label, name, value] of [
  ["a commit missing statusCheckRollup", "checks.json", checksPage({})],
  [
    "checks with another page but no cursor",
    "checks.json",
    checksPage(contexts({ hasNextPage: true, endCursor: null })),
  ],
  [
    "checks whose page omits hasNextPage",
    "checks.json",
    checksPage(contexts({ endCursor: null })),
  ],
  [
    "threads whose page omits hasNextPage",
    "threads.json",
    threadsPage({ endCursor: null }),
  ],
  [
    "threads with a non-boolean hasNextPage",
    "threads.json",
    threadsPage({ hasNextPage: "false", endCursor: null }),
  ],
  [
    "threads with another page but no cursor",
    "threads.json",
    threadsPage({ hasNextPage: true, endCursor: null }),
  ],
  [
    "a failed check with no __typename",
    "checks.json",
    checksPage({
      statusCheckRollup: {
        contexts: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ name: "ci", status: "COMPLETED", conclusion: "FAILURE" }],
        },
      },
    }),
  ],
  [
    "a comment whose author has an unknown account type",
    "comments.json",
    [
      [
        {
          id: 9,
          user: { login: "someone", type: "Robot" },
          body: "hello",
          created_at: "2026-01-01T00:00:09Z",
          updated_at: "2026-01-01T00:00:09Z",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-9",
          author_association: "NONE",
        },
      ],
    ],
  ],
  [
    "a comment with an empty login",
    "comments.json",
    [
      [
        {
          id: 9,
          user: { login: "", type: "User" },
          body: "hello",
          created_at: "2026-01-01T00:00:09Z",
          updated_at: "2026-01-01T00:00:09Z",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-9",
          author_association: "NONE",
        },
      ],
    ],
  ],
  [
    "a comment with a whitespace login",
    "comments.json",
    [
      [
        {
          id: 9,
          user: { login: "   ", type: "User" },
          body: "hello",
          created_at: "2026-01-01T00:00:09Z",
          updated_at: "2026-01-01T00:00:09Z",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-9",
          author_association: "NONE",
        },
      ],
    ],
  ],
  [
    "a comment with a zero id",
    "comments.json",
    [
      [
        {
          id: 0,
          user: { login: "someone", type: "User" },
          body: "hello",
          created_at: "2026-01-01T00:00:09Z",
          updated_at: "2026-01-01T00:00:09Z",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-9",
          author_association: "NONE",
        },
      ],
    ],
  ],
  [
    "two comments with the same id",
    "comments.json",
    [
      [
        {
          id: 9,
          user: { login: "a", type: "User" },
          body: "hello",
          created_at: "2026-01-01T00:00:09Z",
          updated_at: "2026-01-01T00:00:09Z",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-9",
          author_association: "NONE",
        },
        {
          id: 9,
          user: { login: "b", type: "User" },
          body: "hello",
          created_at: "2026-01-01T00:00:09Z",
          updated_at: "2026-01-01T00:00:09Z",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-9",
          author_association: "NONE",
        },
      ],
    ],
  ],
  [
    "a comment whose author has no account type",
    "comments.json",
    [
      [
        {
          id: 9,
          user: { login: "someone" },
          body: "hello",
          created_at: "2026-01-01T00:00:09Z",
          updated_at: "2026-01-01T00:00:09Z",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-9",
          author_association: "NONE",
        },
      ],
    ],
  ],
  [
    "a comment with no body",
    "comments.json",
    [
      [
        {
          id: 9,
          user: { login: "leegmoore", type: "User" },
          created_at: "2026-01-01T00:00:09Z",
          updated_at: "2026-01-01T00:00:09Z",
          html_url: "https://github.com/owner/repo/pull/1#issuecomment-9",
          author_association: "NONE",
        },
      ],
    ],
  ],
  ["a comment with no author_association", "comments.json", commentPage({})],
  [
    "a comment with an unknown author_association",
    "comments.json",
    commentPage({ author_association: "ADMIN" }),
  ],
  [
    "a check run with no checkSuite",
    "checks.json",
    onlyCheck({
      __typename: "CheckRun",
      name: "Cursor Bugbot",
      status: "COMPLETED",
      conclusion: "FAILURE",
      detailsUrl: "",
    }),
  ],
  [
    "a check run whose app has no slug",
    "checks.json",
    onlyCheck({
      __typename: "CheckRun",
      name: "Cursor Bugbot",
      status: "COMPLETED",
      conclusion: "FAILURE",
      detailsUrl: "",
      checkSuite: { app: {} },
    }),
  ],
] as const) {
  it(`treats ${label} as a read error and merges nothing`, async () => {
    const result = await checkWith(name, value);
    expect(result.exit).toBe(2);
    expect(result.out).toStartWith("ERROR: owner/repo#1\n");
  });
}

it("reads a comment from an Enterprise managed user whose login has an underscore", async () => {
  const pages = JSON.parse(readFileSync(join(dir, "comments.json"), "utf8"));
  const result = await checkWith("comments.json", [
    ...pages,
    [
      {
        id: 3,
        user: { login: "mona-cat_octo", type: "User" },
        body: "looks good",
        created_at: "2026-01-01T00:00:02Z",
        updated_at: "2026-01-01T00:00:02Z",
        html_url: "https://github.com/owner/repo/pull/1#issuecomment-3",
        author_association: "CONTRIBUTOR",
      },
    ],
  ]);
  expect(result.exit).toBe(0);
});

it("reads an explicit null statusCheckRollup as no checks", async () => {
  const result = await checkWith(
    "checks.json",
    checksPage({ statusCheckRollup: null })
  );
  expect(result.exit).toBe(0);
  expect(result.out).toContain("met: Checks (no checks reported)");
});

it("treats a PR read with no autoMergeRequest as a read error and merges nothing", async () => {
  const { autoMergeRequest: _, ...rest } = pull();
  const result = await checkWith("pr.json", rest);
  expect(result.exit).toBe(2);
  expect(result.out).toStartWith("ERROR: owner/repo#1\n");
});

it("refuses a PR with auto-merge armed and leaves it armed", async () => {
  const result = await checkWith("pr.json", {
    ...pull(),
    autoMergeRequest: {
      enabledAt: "2026-01-01T00:00:00Z",
      mergeMethod: "SQUASH",
    },
  });
  expect(result.exit).toBe(1);
  expect(result.out).toContain(
    "gh pr merge 1 --repo owner/repo --disable-auto"
  );
});

it("counts a failed check run from an app with no slug in its suite", async () => {
  const result = await checkWith(
    "checks.json",
    onlyCheck({
      __typename: "CheckRun",
      name: "Cursor Bugbot",
      status: "COMPLETED",
      conclusion: "FAILURE",
      detailsUrl: "",
      checkSuite: { app: null, workflowRun: null },
    })
  );
  expect(result.exit).toBe(1);
  expect(result.out).toContain("missing: Checks. 1 failed (Cursor Bugbot)");
});

let workflowRuns = 0;
const actionsRun = (
  conclusion: string | null,
  {
    workflow = "W_ci",
    event = "pull_request",
    run = `R_${++workflowRuns}`,
  } = {}
) => ({
  __typename: "CheckRun",
  name: "test",
  status: conclusion === null ? "IN_PROGRESS" : "COMPLETED",
  conclusion,
  detailsUrl: "",
  checkSuite: {
    app: { slug: "github-actions" },
    workflowRun: { id: run, event, workflow: { id: workflow } },
  },
});
const checksOf = (...nodes: unknown[]) =>
  checksPage({
    statusCheckRollup: {
      contexts: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes,
      },
    },
  });

it("ignores a cancelled run of a check that another run passed", async () => {
  const result = await checkWith(
    "checks.json",
    checksOf(actionsRun("CANCELLED"), actionsRun("SUCCESS"))
  );
  expect(result.exit).toBe(0);
  expect(result.out).toContain("met: Checks (1 passed)");
});

it("waits for a running sibling of a cancelled run", async () => {
  const result = await checkWith(
    "checks.json",
    checksOf(actionsRun("CANCELLED"), actionsRun(null))
  );
  expect(result.exit).toBe(1);
  expect(result.out).toContain("missing: Checks. 1 still running (test)");
});

it("fails on a failed sibling of a cancelled run", async () => {
  const result = await checkWith(
    "checks.json",
    checksOf(actionsRun("CANCELLED"), actionsRun("FAILURE"))
  );
  expect(result.exit).toBe(1);
  expect(result.out).toContain("missing: Checks. 1 failed (test)");
});

it("counts cancelled runs that no other run of the check outlived", async () => {
  const result = await checkWith(
    "checks.json",
    checksOf(actionsRun("CANCELLED"), actionsRun("CANCELLED"))
  );
  expect(result.exit).toBe(1);
  expect(result.out).toContain("missing: Checks. 2 failed (test, test)");
});

it("counts a cancelled run when only another workflow's check of that name passed", async () => {
  const result = await checkWith(
    "checks.json",
    checksOf(
      actionsRun("CANCELLED"),
      actionsRun("SUCCESS", { workflow: "W_other" })
    )
  );
  expect(result.exit).toBe(1);
  expect(result.out).toContain("missing: Checks. 1 failed (test)");
});

it("counts a cancelled run when only another event's run of the check passed", async () => {
  const result = await checkWith(
    "checks.json",
    checksOf(actionsRun("CANCELLED"), actionsRun("SUCCESS", { event: "push" }))
  );
  expect(result.exit).toBe(1);
  expect(result.out).toContain("missing: Checks. 1 failed (test)");
});

it("counts a cancelled job next to a passed job of the same name in its own workflow run", async () => {
  const result = await checkWith(
    "checks.json",
    checksOf(
      actionsRun("CANCELLED", { run: "R_a" }),
      actionsRun("SUCCESS", { run: "R_a" })
    )
  );
  expect(result.exit).toBe(1);
  expect(result.out).toContain("missing: Checks. 1 failed (test)");
});

it("counts a cancelled job when no other workflow run finished that name uncancelled", async () => {
  const result = await checkWith(
    "checks.json",
    checksOf(
      actionsRun("SUCCESS", { run: "R_a" }),
      actionsRun("CANCELLED", { run: "R_a" }),
      actionsRun("SUCCESS", { run: "R_b" }),
      actionsRun("CANCELLED", { run: "R_b" })
    )
  );
  expect(result.exit).toBe(1);
  expect(result.out).toContain("missing: Checks. 2 failed (test, test)");
});

it.each([
  ["pull_request", null, "1 still running (test)"],
  ["pull_request", "FAILURE", "1 failed (test)"],
  ["workflow_dispatch", null, "1 still running (test)"],
  ["workflow_dispatch", "FAILURE", "1 failed (test)"],
])(
  "keeps a %s run in state %p that another run of the check passed",
  async (event, conclusion, missing) => {
    const result = await checkWith(
      "checks.json",
      checksOf(
        actionsRun(conclusion, { event }),
        actionsRun("SUCCESS", { event })
      )
    );
    expect(result.exit).toBe(1);
    expect(result.out).toContain(`missing: Checks. ${missing}`);
  }
);

it("counts every run of a check from outside GitHub Actions", async () => {
  const appRun = (conclusion: string) => ({
    __typename: "CheckRun",
    name: "lint",
    status: "COMPLETED",
    conclusion,
    detailsUrl: "",
    checkSuite: { app: { slug: "macroscopeapp" }, workflowRun: null },
  });
  const result = await checkWith(
    "checks.json",
    checksOf(appRun("CANCELLED"), appRun("SUCCESS"))
  );
  expect(result.exit).toBe(1);
  expect(result.out).toContain("missing: Checks. 1 failed (lint)");
});

it("reads the merge brief raw from the default branch, null when GitHub has none", async () => {
  const github = new GhGitHub();
  const repo = { owner: "owner", repo: "repo" };
  expect(await github.mergeBrief(repo)).toBeNull();
  writeFileSync(join(dir, "merge-brief.md"), "# Merging\n");
  try {
    expect(await github.mergeBrief(repo)).toBe("# Merging\n");
  } finally {
    rmSync(join(dir, "merge-brief.md"));
  }
});

it("throws when the merge brief read fails for any reason but a 404", async () => {
  await expect(
    new GhGitHub().mergeBrief({ owner: "broken", repo: "repo" })
  ).rejects.toThrow("gh: Server Error (HTTP 502)");
});
