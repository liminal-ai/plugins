import { beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./cli.ts";
import {
  type FakeOptions,
  type Repos,
  REPO,
  codexComment,
  comment,
  failing,
  fakeGitHub,
  makeRepos,
  passing,
  running,
  runtimeFor,
  verdictComment,
} from "./fakes.test-helper.ts";

let repos: Repos;
beforeAll(() => {
  repos = makeRepos();
});

/** Comments that satisfy the verdict and Codex requirements for `head` on main. */
const approvals = (head = repos.head, base = repos.main) => [
  verdictComment("PASS", head, base),
  codexComment(head),
];

async function gate(
  options: Partial<FakeOptions> = {},
  flags: readonly string[] = ["--check"]
) {
  const github = fakeGitHub({
    comments: approvals(),
    ...options,
    pull: { headRefOid: repos.head, ...options.pull },
  });
  const runtime = runtimeFor(github, repos.gate);
  const exit = await main(["--repo", REPO, "--pr", "1", ...flags], runtime);
  const out = runtime.out();
  const missing = out
    .split("\n")
    .filter((line) => line.startsWith("missing: "));
  const log = () =>
    readFileSync(join(runtime.store, "merge-gate", "runs.tsv"), "utf8");
  return { exit, out, missing, calls: github.calls, log };
}

const merged = (calls: readonly string[]) =>
  calls.some((call) => call.startsWith("merge "));

describe("merge-gate", () => {
  it("would merge when every requirement is met, and merges nothing under --check", async () => {
    const result = await gate();
    expect(result.exit).toBe(0);
    expect(result.out.split("\n")[0]).toBe(
      `WOULD MERGE: owner/repo#1 at ${repos.head.slice(0, 7)}`
    );
    expect(result.missing).toEqual([]);
    expect(result.out).toContain("met: Checks");
    expect(merged(result.calls)).toBe(false);
  });

  it("merges the evaluated head with every gh call naming the repo", async () => {
    const result = await gate({}, []);
    expect(result.exit).toBe(0);
    expect(result.out.split("\n")[0]).toBe(
      `MERGED: owner/repo#1 at ${repos.head.slice(0, 7)} into main as fffffff`
    );
    expect(result.calls).toContain(`merge owner/repo#1 ${repos.head}`);
    expect(
      result.calls.every((call) => call.split(" ")[1]?.startsWith("owner/repo"))
    ).toBe(true);
  });

  describe("open and mergeable", () => {
    for (const [label, pull, text] of [
      ["draft", { isDraft: true }, "draft"],
      ["closed", { state: "CLOSED" }, "closed"],
      ["merged", { state: "MERGED" }, "already merged"],
      ["conflicting", { mergeable: "CONFLICTING" }, "conflicts with main"],
      ["mergeability unknown", { mergeable: "UNKNOWN" }, "Run the gate again"],
      [
        "stacked on its parent",
        { baseRefName: "parent" },
        "targets parent, not main",
      ],
    ] as const) {
      it(`refuses a PR that is ${label}`, async () => {
        const result = await gate(
          { pull: { headRefOid: repos.head, ...pull } },
          []
        );
        expect(result.exit).toBe(1);
        expect(result.missing.join("\n")).toContain("Open and mergeable");
        expect(result.missing.join("\n")).toContain(text);
        expect(merged(result.calls)).toBe(false);
      });
    }
  });

  describe("checks", () => {
    it("refuses a failed check and names it", async () => {
      const result = await gate({ checks: [passing(), failing("build")] });
      expect(result.exit).toBe(1);
      expect(result.missing).toEqual([
        expect.stringMatching(/^missing: Checks\. 1 failed \(build\)/),
      ]);
    });

    it("refuses a check still running", async () => {
      const result = await gate({ checks: [running("test")] });
      expect(result.exit).toBe(1);
      expect(result.missing[0]).toContain("1 still running (test)");
    });

    it("is met with no checks reported", async () => {
      const result = await gate({ checks: [] });
      expect(result.exit).toBe(0);
      expect(result.out).toContain("met: Checks (no checks reported)");
    });

    it("ignores Bugbot entirely, running or failed", async () => {
      const result = await gate({
        checks: [passing(), running("Cursor Bugbot"), failing("BUGBOT review")],
      });
      expect(result.exit).toBe(0);
      expect(result.out).toContain("met: Checks (1 passed, 2 Bugbot ignored)");
    });
  });

  describe("review threads", () => {
    it("refuses an unresolved thread and lists who, where, what and the link", async () => {
      const result = await gate({
        threads: [
          {
            author: "chatgpt-codex-connector",
            path: "src/a.ts",
            line: 12,
            body: "\n**P1** Handle the empty case\n\nMore text",
            url: "https://github.com/owner/repo/pull/1#discussion_r9",
          },
        ],
      });
      expect(result.exit).toBe(1);
      expect(result.out).toContain("missing: Review threads. 1 unresolved.");
      expect(result.out).toContain(
        "  chatgpt-codex-connector at src/a.ts:12: **P1** Handle the empty case https://github.com/owner/repo/pull/1#discussion_r9"
      );
    });

    it("is met with none open", async () => {
      const result = await gate({ threads: [] });
      expect(result.out).toContain("met: Review threads (none open)");
    });
  });

  describe("independent verdict", () => {
    const verdictLine = (out: string) =>
      out
        .split("\n")
        .find((line) => line.startsWith("missing: Independent verdict")) ?? "";

    it("refuses with no verdict and prints the line to post for this head and merge base", async () => {
      const result = await gate({ comments: [codexComment(repos.head)] });
      expect(result.exit).toBe(1);
      expect(verdictLine(result.out)).toContain(
        `"pstack-verdict: <PASS|PASS+NOTES|FAIL> head=${repos.head} base=${repos.main} by=<model>"`
      );
    });

    it("refuses a FAIL verdict", async () => {
      const result = await gate({
        comments: [
          verdictComment("FAIL", repos.head, repos.main),
          codexComment(repos.head),
        ],
      });
      expect(result.exit).toBe(1);
      expect(verdictLine(result.out)).toContain("The latest verdict is FAIL");
    });

    it("uses the most recent verdict: a newer FAIL beats an older PASS", async () => {
      const result = await gate({
        comments: [
          verdictComment("PASS", repos.head, repos.main),
          verdictComment("FAIL", repos.head, repos.main),
          codexComment(repos.head),
        ],
      });
      expect(result.exit).toBe(1);
      expect(verdictLine(result.out)).toContain("FAIL");
    });

    it("uses the most recent verdict: a newer PASS+NOTES beats an older FAIL", async () => {
      const result = await gate({
        comments: [
          verdictComment("FAIL", repos.head, repos.main),
          verdictComment("PASS+NOTES", repos.head, repos.main),
          codexComment(repos.head),
        ],
      });
      expect(result.exit).toBe(0);
      expect(result.out).toContain(
        "met: Independent verdict (PASS+NOTES by codex/gpt-6.1-sol covers this code)"
      );
    });

    it("refuses when the latest verdict line is malformed, even with an older PASS", async () => {
      const result = await gate({
        comments: [
          verdictComment("PASS", repos.head, repos.main),
          comment(`pstack-verdict: FAIL head=${repos.head.slice(0, 7)}`),
          codexComment(repos.head),
        ],
      });
      expect(result.exit).toBe(1);
      expect(verdictLine(result.out)).toContain("does not read as");
    });

    it("covers a rebased head whose change is identical, fetching a force-pushed-away commit by SHA", async () => {
      const result = await gate({
        comments: [
          verdictComment("PASS", repos.oldHead, repos.c0),
          codexComment(repos.head),
        ],
      });
      expect(result.exit).toBe(0);
      expect(result.out).toContain("met: Independent verdict");
    });

    it("refuses when the code changed since the verdict", async () => {
      const result = await gate({
        pull: { headRefOid: repos.changedHead },
        comments: [
          verdictComment("PASS", repos.head, repos.main),
          codexComment(repos.changedHead),
        ],
      });
      expect(result.exit).toBe(1);
      expect(verdictLine(result.out)).toContain(
        "because the code changed since the verdict"
      );
    });

    it("refuses when the verdict names a commit the remote does not have", async () => {
      const result = await gate({
        comments: [
          verdictComment("PASS", "1".repeat(40), repos.main),
          codexComment(repos.head),
        ],
      });
      expect(result.exit).toBe(1);
      expect(verdictLine(result.out)).toContain("could not be fetched");
    });
  });

  describe("codex review", () => {
    const ask =
      'Comment "@codex review" on the PR and wait for Codex\'s summary comment to name this head.';

    it("refuses when Codex last reviewed an older head", async () => {
      const result = await gate({
        comments: [
          verdictComment("PASS", repos.head, repos.main),
          codexComment(repos.oldHead),
        ],
      });
      expect(result.exit).toBe(1);
      expect(result.missing).toEqual([
        `missing: Codex review. Codex last reviewed ${repos.oldHead.slice(0, 7)}, not ${repos.head.slice(0, 7)}. ${ask}`,
      ]);
    });

    it("refuses when Codex has not reviewed", async () => {
      const result = await gate({
        comments: [verdictComment("PASS", repos.head, repos.main)],
      });
      expect(result.exit).toBe(1);
      expect(result.missing).toEqual([
        `missing: Codex review. Codex has not reviewed the PR. ${ask}`,
      ]);
    });

    it("refuses while Codex's review of this head is still running", async () => {
      const result = await gate({
        comments: [
          verdictComment("PASS", repos.head, repos.main),
          codexComment(repos.head, "in_progress"),
        ],
      });
      expect(result.exit).toBe(1);
      expect(result.missing[0]).toContain("is in_progress, not completed");
    });

    it("ignores the review-state marker from anyone but Codex", async () => {
      const forged = {
        ...codexComment(repos.head),
        author: "someone",
        isBot: false,
      };
      const result = await gate({
        comments: [verdictComment("PASS", repos.head, repos.main), forged],
      });
      expect(result.exit).toBe(1);
      expect(result.missing[0]).toContain("Codex has not reviewed the PR");
    });
  });

  describe("instruction-file approval", () => {
    const approvalHash = (head: string) =>
      createHash("sha256")
        .update(
          `${repos.git(repos.remote, "diff-tree", "-r", "--no-renames", "--full-index", "--abbrev=40", repos.main, head, "--", "AGENTS.md", "sub/Claude.md")}\n`
        )
        .digest("hex");
    const withHead = (
      head: string,
      ...extra: ReturnType<typeof comment>[]
    ) => ({
      pull: { headRefOid: head },
      comments: [...approvals(head), ...extra],
    });

    it("refuses an AGENTS.md or CLAUDE.md change without approval and prints the exact line for Lee", async () => {
      const result = await gate(withHead(repos.instructionHead));
      expect(result.exit).toBe(1);
      expect(result.missing[0]).toContain(
        "The PR changes AGENTS.md, sub/Claude.md."
      );
      expect(result.out).toContain(
        `\n  lee-approves-instruction-files: ${approvalHash(repos.instructionHead)}\n`
      );
    });

    it("is met when Lee approved this exact text", async () => {
      const result = await gate(
        withHead(
          repos.instructionHead,
          comment(
            `lee-approves-instruction-files: ${approvalHash(repos.instructionHead)}`
          )
        )
      );
      expect(result.exit).toBe(0);
      expect(result.out).toContain("met: Instruction-file approval");
    });

    it("refuses new text approved only for the old text", async () => {
      const old = comment(
        `lee-approves-instruction-files: ${approvalHash(repos.instructionHead)}`
      );
      const result = await gate(withHead(repos.editedInstructionHead, old));
      expect(result.exit).toBe(1);
      expect(result.out).toContain(
        `lee-approves-instruction-files: ${approvalHash(repos.editedInstructionHead)}`
      );
      expect(approvalHash(repos.editedInstructionHead)).not.toBe(
        approvalHash(repos.instructionHead)
      );
    });

    it("does not count an approval line posted by a bot", async () => {
      const bot = comment(
        `lee-approves-instruction-files: ${approvalHash(repos.instructionHead)}`,
        "some-app[bot]",
        true
      );
      const result = await gate(withHead(repos.instructionHead, bot));
      expect(result.exit).toBe(1);
    });
  });

  describe("read errors never pass", () => {
    for (const step of [
      "checks",
      "openThreads",
      "issueComments",
      "pullRequest",
    ] as const) {
      it(`exits 2 and merges nothing when ${step} fails`, async () => {
        const result = await gate({ failOn: step }, []);
        expect(result.exit).toBe(2);
        expect(result.out).toStartWith("ERROR: owner/repo#1\n");
        expect(merged(result.calls)).toBe(false);
        expect(result.log().trim().split("\n")[1]).toContain(
          "\tmerge\terror\tread error: "
        );
      });
    }

    it("exits 2 when no remote in the clone points at the repo", async () => {
      const github = fakeGitHub({ pull: { headRefOid: repos.head } });
      const runtime = runtimeFor(github, repos.gate);
      const exit = await main(["--repo", "other/repo", "--pr", "1"], runtime);
      expect(exit).toBe(2);
      expect(runtime.out()).toContain("no git remote in");
      expect(github.calls).toEqual([]);
    });
  });

  describe("merge read-back", () => {
    it("refuses when the merge only queued", async () => {
      const result = await gate(
        { readBack: { state: "OPEN", mergedAt: null, mergeCommit: null } },
        []
      );
      expect(result.exit).toBe(1);
      expect(result.out).toStartWith(
        `NOT MERGED: owner/repo#1 at ${repos.head.slice(0, 7)}\n`
      );
      expect(result.out).toContain("GitHub reads the PR as OPEN against main");
    });

    it("refuses when it merged into another base", async () => {
      const result = await gate({ readBack: { baseRefName: "parent" } }, []);
      expect(result.exit).toBe(1);
      expect(result.out).toContain("not merged into main");
    });

    it("refuses when the merge command fails, as when the head moved", async () => {
      const result = await gate(
        {
          merge: { ok: false, detail: "Head branch was modified" },
          readBack: { state: "OPEN", mergedAt: null },
        },
        []
      );
      expect(result.exit).toBe(1);
      expect(result.out).toContain(
        "The merge command failed: Head branch was modified."
      );
    });
  });

  it("logs every run to runs.tsv with a header", async () => {
    const result = await gate({ checks: [failing("build")], threads: [] });
    expect(result.log().split("\n")).toEqual([
      "ts\trepo\tpr\thead\tmode\toutcome\tmissing",
      `2026-10-17T12:00:00.000Z\towner/repo\t1\t${repos.head}\tcheck\trefused\tChecks`,
      "",
    ]);
  });

  it("logs a passing --check as would-merge, not merged", async () => {
    const result = await gate();
    expect(result.exit).toBe(0);
    expect(result.log()).toContain("\tcheck\twould-merge\t");
  });

  it("defaults --repo to the origin remote's repo", async () => {
    const github = fakeGitHub({
      comments: approvals(),
      pull: { headRefOid: repos.head },
    });
    const runtime = runtimeFor(github, repos.gate);
    expect(await main(["--pr", "1", "--check"], runtime)).toBe(0);
    expect(github.calls[0]).toStartWith("defaultBranch owner/repo");
  });

  it("exits 2 on bad usage", async () => {
    const runtime = runtimeFor(
      fakeGitHub({ pull: { headRefOid: "x" } }),
      repos.gate
    );
    expect(await main(["--check"], runtime)).toBe(2);
    expect(await main(["--pr", "abc"], runtime)).toBe(2);
    expect(await main(["--pr", "1", "--repo", "noslash"], runtime)).toBe(2);
  });
});
