import { beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.ts";
import type { IssueComment } from "./gate.ts";
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
  const out = runtime.decision();
  const missing = out
    .split("\n")
    .filter((line) => line.startsWith("missing: "));
  const log = () =>
    readFileSync(join(runtime.store, "merge-gate", "runs.tsv"), "utf8");
  return { exit, out, full: runtime.out(), missing, calls: github.calls, log };
}

/** Runs `body` with git config entries every git child process sees, as GIT_CONFIG_COUNT passes them. */
async function withGitConfig<T>(
  entries: Record<string, string>,
  body: () => Promise<T>
): Promise<T> {
  const pairs = Object.entries(entries);
  const keys = ["GIT_CONFIG_COUNT", ...pairs.flatMap((_, i) => [`GIT_CONFIG_KEY_${i}`, `GIT_CONFIG_VALUE_${i}`])];
  const saved = keys.map((key) => [key, process.env[key]] as const);
  process.env.GIT_CONFIG_COUNT = String(pairs.length);
  pairs.forEach(([key, value], i) => {
    process.env[`GIT_CONFIG_KEY_${i}`] = key;
    process.env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  try {
    return await body();
  } finally {
    for (const [key, value] of saved)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
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
    expect(result.calls).toContain(`merge owner/repo#1 ${repos.head} squash`);
    expect(
      result.calls.every((call) => call.split(" ")[1]?.startsWith("owner/repo"))
    ).toBe(true);
  });

  for (const method of ["merge", "rebase"] as const)
    it(`merges the evaluated head by ${method} under --method ${method}`, async () => {
      const result = await gate({}, ["--method", method]);
      expect(result.exit).toBe(0);
      expect(result.calls).toContain(
        `merge owner/repo#1 ${repos.head} ${method}`
      );
    });

  it("exits 2 and merges nothing on an unknown --method", async () => {
    const result = await gate({}, ["--method", "fast-forward"]);
    expect(result.exit).toBe(2);
    expect(result.out).toContain("--method");
    expect(merged(result.calls)).toBe(false);
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

  it("refuses, and queues nothing, when the base branch uses a merge queue", async () => {
    const result = await gate({ mergeQueue: true }, []);
    expect(result.exit).toBe(1);
    expect(result.missing.join("\n")).toContain("main uses a merge queue");
    expect(merged(result.calls)).toBe(false);
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

    it("ignores Bugbot's own check runs from the Cursor app, running or failed", async () => {
      const result = await gate({
        checks: [
          passing(),
          running("Cursor Bugbot", "cursor"),
          failing("Cursor Bugbot", "cursor"),
        ],
      });
      expect(result.exit).toBe(0);
      expect(result.out).toContain("met: Checks (1 passed, 2 Bugbot ignored)");
    });

    it("counts a check named Bugbot that another app or a commit status reports", async () => {
      const result = await gate({
        checks: [
          passing(),
          failing("bugbot-lint", "github-actions"),
          running("Cursor Bugbot", null),
        ],
      });
      expect(result.exit).toBe(1);
      expect(result.missing).toEqual([
        "missing: Checks. 1 failed (bugbot-lint). Fix the failures and push. 1 still running (Cursor Bugbot). Wait for them to finish, then run the gate again.",
      ]);
    });
  });

  it("refuses while a reviewer's requested changes stand", async () => {
    const result = await gate({
      pull: { headRefOid: repos.head, reviewDecision: "CHANGES_REQUESTED" },
    });
    expect(result.exit).toBe(1);
    expect(result.missing).toEqual([
      expect.stringMatching(
        /^missing: Review decision\. A reviewer requested changes/
      ),
    ]);
  });

  it("refuses, and leaves it armed, when auto-merge is armed on the PR", async () => {
    const result = await gate(
      { pull: { headRefOid: repos.head, autoMergeArmed: true } },
      []
    );
    expect(result.exit).toBe(1);
    expect(result.missing).toEqual([
      expect.stringMatching(/^missing: Auto-merge\. /),
    ]);
    expect(result.out).toContain(
      "gh pr merge 1 --repo owner/repo --disable-auto"
    );
    expect(merged(result.calls)).toBe(false);
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
        "  chatgpt-codex-connector at src/a.ts:12: P1 Handle the empty case https://github.com/owner/repo/pull/1#discussion_r9"
      );
    });

    it("previews the readable title, not badge images or HTML around it", async () => {
      const result = await gate({
        threads: [
          {
            author: "chatgpt-codex-connector",
            path: "a.md",
            line: 19,
            body: "**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Gate READY on the Codex state marker before accepting the watcher's word**\n\nAfter a push...",
            url: "https://github.com/owner/repo/pull/1#discussion_r10",
          },
        ],
      });
      expect(result.out).toContain(
        "  chatgpt-codex-connector at a.md:19: Gate READY on the Codex state marker before accepting the watcher's word https://github.com/owner/repo/pull/1#discussion_r10"
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

    it("ignores a verdict line from an account that is not an owner, member or collaborator", async () => {
      const forged = comment(
        `pstack-verdict: PASS head=${repos.head} base=${repos.main} by=codex/gpt-6.1-sol`,
        "drive-by",
        false,
        "NONE"
      );
      const result = await gate({
        comments: [codexComment(repos.head), forged],
      });
      expect(result.exit).toBe(1);
      expect(verdictLine(result.out)).toStartWith(
        "missing: Independent verdict. No verdict on the PR."
      );
      expect(result.out).toContain(`  ignored: drive-by (NONE) ${forged.url}`);
    });

    it("counts a verdict line from a collaborator or the owner", async () => {
      for (const association of ["COLLABORATOR", "OWNER"] as const) {
        const result = await gate({
          comments: [
            comment(
              `pstack-verdict: PASS head=${repos.head} base=${repos.main} by=codex/gpt-6.1-sol`,
              "someone",
              false,
              association
            ),
            codexComment(repos.head),
          ],
        });
        expect(result.exit).toBe(0);
      }
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

    it("refuses a FAIL that the lead's ruling after it calls a trunk defect", async () => {
      const result = await gate({
        comments: [
          verdictComment("FAIL", repos.head, repos.main),
          comment(
            `pstack-ruling: head=${repos.head} by=claudeAgent/claude-opus-5-5\nThe one finding is a trunk defect, so it does not gate this PR.`
          ),
          codexComment(repos.head),
        ],
      });
      expect(result.exit).toBe(1);
      expect(verdictLine(result.out)).toContain(
        "The lead's ruling on a finding never turns a FAIL into a pass"
      );
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

    it("breaks a same-second tie toward the later comment: FAIL after PASS refuses", async () => {
      const pass = verdictComment("PASS", repos.head, repos.main);
      const fail = {
        ...verdictComment("FAIL", repos.head, repos.main),
        createdAt: pass.createdAt,
        updatedAt: pass.updatedAt,
      };
      const result = await gate({
        comments: [pass, fail, codexComment(repos.head)],
      });
      expect(result.exit).toBe(1);
      expect(verdictLine(result.out)).toContain("The latest verdict is FAIL");
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

  describe("plan boxes", () => {
    const plan = join(import.meta.dir, "fixtures", "gc2-plan.md");
    const planFlags = ["--check", "--plan", plan, "--plan-pr", "GC2"];
    const GC2_IDS = [
      ...[1, 2, 3, 4, 5].map((n) => `unit-${n}`),
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `live-${n}`),
      "perf",
    ];
    const verdictWith = (boxLines: readonly string[]) =>
      comment(
        `pstack-verdict: PASS+NOTES head=${repos.head} base=${repos.main} by=codex/gpt-6.1-sol\n\n${boxLines.join("\n")}\n\nFindings below.`
      );
    const allDone = () => GC2_IDS.map((id) => `box ${id}: done`);
    const planGate = (comments: readonly IssueComment[], flags = planFlags) =>
      gate({ comments: [...comments, codexComment(repos.head)] }, flags);

    it("refuses GC2's real PASS+NOTES verdict, which lists none of the plan's boxes", async () => {
      const body = readFileSync(
        join(import.meta.dir, "fixtures", "gc2-verdict.md"),
        "utf8"
      );
      const result = await planGate([comment(body)]);
      expect(result.exit).toBe(1);
      const line = result.missing.find((l) => l.startsWith("missing: Plan boxes."));
      expect(line).toContain("The verdict omits 16 required boxes of GC2");
      expect(result.out).toContain(`  omitted: ${GC2_IDS.join(" ")}`);
    });

    it("would merge when the verdict lists every required box", async () => {
      const result = await planGate([verdictWith(allDone())]);
      expect(result.exit).toBe(0);
      expect(result.out).toContain(
        "met: Plan boxes (all 16 required boxes of GC2 listed)"
      );
    });

    it("reads box lines written as a list or in bold", async () => {
      const lines = allDone().map((line, i) =>
        i % 2 === 0 ? `- ${line}` : `**${line}**`
      );
      expect((await planGate([verdictWith(lines)])).exit).toBe(0);
    });

    it("requires the boxes of lanes indented in the plan", async () => {
      const directory = mkdtempSync(join(tmpdir(), "merge-gate-plan-"));
      const indented = join(directory, "plan.md");
      writeFileSync(
        indented,
        readFileSync(plan, "utf8").replaceAll(/^- \[ \] Lane/gm, " - [ ] Lane")
      );
      try {
        const result = await planGate(
          [verdictWith(allDone().filter((line) => !line.includes("live-")))],
          ["--check", "--plan", indented, "--plan-pr", "GC2"]
        );
        expect(result.exit).toBe(1);
        expect(result.out).toContain(
          `  omitted: ${GC2_IDS.filter((id) => id.startsWith("live-")).join(" ")}`
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it("reads only the box lines under the verdict line that counts", async () => {
      const edited = comment(
        [
          `pstack-verdict: PASS+NOTES head=${repos.oldHead} base=${repos.c0} by=codex/gpt-6.1-sol`,
          ...allDone(),
          `pstack-verdict: PASS+NOTES head=${repos.head} base=${repos.main} by=codex/gpt-6.1-sol`,
          "Rechecked at the new head.",
        ].join("\n")
      );
      const result = await planGate([edited]);
      expect(result.exit).toBe(1);
      expect(result.out).toContain(`  omitted: ${GC2_IDS.join(" ")}`);
    });

    it("refuses a box listed more than once", async () => {
      for (const extra of ["box live-1: n/a. It did not run.", "box live-1: done"]) {
        const result = await planGate([verdictWith([...allDone(), extra])]);
        expect(result.exit).toBe(1);
        expect(result.out).toContain("  listed more than once: live-1");
      }
    });

    it("refuses a verdict that omits one box", async () => {
      const result = await planGate([
        verdictWith(allDone().filter((line) => !line.includes("live-7"))),
      ]);
      expect(result.exit).toBe(1);
      expect(result.out).toContain("  omitted: live-7");
    });

    const perfSkipped = () =>
      allDone().map((line) =>
        line === "box perf: done"
          ? "box perf: skipped. Trunk lacks the feature, so no comparison ran."
          : line
      );
    const waive = (...values: string[]) =>
      values.flatMap((value) => ["--accept-skip", value]);

    it("refuses a skip the lead has not waived on the gate run", async () => {
      const result = await planGate([verdictWith(perfSkipped())]);
      expect(result.exit).toBe(1);
      expect(result.out).toContain("  not accepted: perf");
      expect(result.out).toContain('"--accept-skip <id>=<reason>"');
    });

    it("refuses a skip an older verifier's comment signs, when a later verifier skips the same box", async () => {
      const older = comment(
        [
          `pstack-verdict: PASS+NOTES head=${repos.oldHead} base=${repos.c0} by=claudeAgent/claude-opus-5-5`,
          "pstack-skip: perf by=claudeAgent/claude-opus-5-5 GC4 measures the same path against trunk.",
        ].join("\n")
      );
      const result = await planGate([older, verdictWith(perfSkipped())]);
      expect(result.exit).toBe(1);
      expect(result.out).toContain("  not accepted: perf");
      expect(result.out).not.toContain("WOULD MERGE");
    });

    it("refuses a skip the verifier signs itself, under its own name or the lead's", async () => {
      const signatures = [
        "pstack-skip: perf by=codex/gpt-6.1-sol I am the verifier and accept my own skip.",
        "pstack-skip: perf by=claudeAgent/claude-opus-5-5 I am the verifier, writing as the lead.",
      ];
      for (const comments of signatures.flatMap((signature) => [
        [verdictWith([...perfSkipped(), signature])],
        [verdictWith(perfSkipped()), comment(signature)],
      ])) {
        const result = await planGate(comments);
        expect(result.exit).toBe(1);
        expect(result.out).toContain("  not accepted: perf");
      }
    });

    it("would merge a skip the lead waives with a reason, and logs the waiver", async () => {
      const result = await planGate(
        [verdictWith(perfSkipped())],
        [...planFlags, ...waive("perf=GC4 measures the same path against trunk.")]
      );
      expect(result.exit).toBe(0);
      expect(result.out).toContain(
        "met: Plan boxes (all 16 required boxes of GC2 listed, 1 skip accepted by the lead)"
      );
      expect(result.calls.some((call) => call.startsWith("comment "))).toBe(false);
      expect(result.log().split("\n")[1]).toEndWith(
        '\tcheck\twould-merge\t\t[{"kind":"skip","id":"perf","reason":"GC4 measures the same path against trunk."}]'
      );
    });

    it("posts the waivers on the PR before it merges, and logs them", async () => {
      const verdict = verdictWith(perfSkipped());
      const result = await planGate(
        [verdict],
        ["--plan", plan, "--plan-pr", "GC2", ...waive("perf=GC4 measures the same path against trunk.")]
      );
      expect(result.exit).toBe(0);
      const posted = result.calls.findIndex((call) => call.startsWith("comment "));
      expect(result.calls[posted]).toBe(
        `comment owner/repo#1 merge-gate: the lead waived these skipped boxes of the verdict ${verdict.url} to merge ${repos.head}.\n\n- perf: GC4 measures the same path against trunk.`
      );
      expect(posted).toBeLessThan(
        result.calls.findIndex((call) => call.startsWith("merge "))
      );
      expect(result.calls.filter((call) => call.startsWith("comment "))).toHaveLength(1);
      expect(result.log().split("\n")[1]).toEndWith(
        '\tmerge\tmerged\t\t[{"kind":"skip","id":"perf","reason":"GC4 measures the same path against trunk."}]'
      );
    });

    it("merges nothing when the waivers cannot be posted", async () => {
      const result = await gate(
        {
          comments: [verdictWith(perfSkipped()), codexComment(repos.head)],
          comment: { ok: false, detail: "HTTP 502" },
        },
        ["--plan", plan, "--plan-pr", "GC2", ...waive("perf=covered by GC4")]
      );
      expect(result.exit).toBe(1);
      expect(result.out).toContain("could not be posted on the PR (HTTP 502)");
      expect(merged(result.calls)).toBe(false);
    });

    it("merges nothing when the verdict at merge time no longer skips a waived box", async () => {
      const result = await gate(
        {
          comments: [verdictWith(perfSkipped()), codexComment(repos.head)],
          atMerge: {
            comments: [verdictWith(allDone()), codexComment(repos.head)],
          },
        },
        ["--plan", plan, "--plan-pr", "GC2", ...waive("perf=covered by GC4")]
      );
      expect(result.exit).toBe(1);
      expect(result.out).toContain("does not skip box perf");
      expect(result.calls.some((call) => call.startsWith("comment "))).toBe(false);
      expect(merged(result.calls)).toBe(false);
    });

    it("exits 2 on an --accept-skip with no reason, a bad id, or a box waived twice", async () => {
      for (const [values, text] of [
        [["perf="], "box perf needs a reason"],
        [["perf=   "], "box perf needs a reason"],
        [["perf"], "box perf needs a reason"],
        [["Perf=reason"], '"Perf" is not a box id'],
        [["perf=one", "perf=two"], "box perf is given more than once"],
      ] as const) {
        const result = await planGate(
          [verdictWith(perfSkipped())],
          [...planFlags, ...waive(...values)]
        );
        expect(result.exit).toBe(2);
        expect(result.out).toContain(text);
        expect(merged(result.calls)).toBe(false);
      }
    });

    const defer = (...values: string[]) =>
      values.flatMap((value) => ["--defer", value]);

    it("would merge a box the lead defers to its owner, posting and logging the owner and what is owed", async () => {
      const verdict = verdictWith(perfSkipped());
      const check = await planGate([verdict], [...planFlags, ...defer("perf=LH-215")]);
      expect(check.exit).toBe(0);
      expect(check.out).toContain(
        "met: Plan boxes (all 16 required boxes of GC2 listed, 1 box deferred)\n  deferred: box perf to LH-215: Trunk lacks the feature, so no comparison ran.\n"
      );
      const result = await planGate(
        [verdict],
        ["--plan", plan, "--plan-pr", "GC2", ...defer("perf=mcp:launch:e22d/w1.7")]
      );
      expect(result.exit).toBe(0);
      expect(result.calls.find((call) => call.startsWith("comment "))).toBe(
        `comment owner/repo#1 merge-gate: the lead deferred these skipped boxes of the verdict ${verdict.url} to their owners to merge ${repos.head}.\n\n- perf: mcp:launch:e22d/w1.7. Owed: Trunk lacks the feature, so no comparison ran.`
      );
      expect(result.log().split("\n")[1]).toEndWith(
        '\tmerge\tmerged\t\t[{"kind":"defer","id":"perf","reason":"mcp:launch:e22d/w1.7"}]'
      );
    });

    it("exits 2 on a --defer with no owner, or one that is neither a Linear id nor a workflow step", async () => {
      for (const [value, text] of [
        ["perf", "box perf needs an owner: --defer perf=<owner>"],
        ["perf=", "box perf needs an owner"],
        ["perf=later", 'owner "later" is neither a Linear id'],
        ["perf=runs on staging after merge", "is neither a Linear id"],
        ["perf=w1.7", "is neither a Linear id"],
      ] as const) {
        const result = await planGate([verdictWith(perfSkipped())], [...planFlags, ...defer(value)]);
        expect(result.exit).toBe(2);
        expect(result.out).toContain(text);
      }
    });

    it("exits 2 on a box both accepted and deferred, or deferred when the verdict did not skip it", async () => {
      const both = await planGate(
        [verdictWith(perfSkipped())],
        [...planFlags, ...waive("perf=covered by GC4"), ...defer("perf=LH-215")]
      );
      expect(both.exit).toBe(2);
      expect(both.out).toContain("box perf is both accepted and deferred");
      const stray = await planGate([verdictWith(allDone())], [...planFlags, ...defer("perf=LH-215")]);
      expect(stray.exit).toBe(2);
      expect(stray.out).toContain("--defer perf: the verdict");
      expect(stray.out).toContain("does not skip box perf");
    });

    it("exits 2 on an --accept-skip for a box the verdict did not skip", async () => {
      for (const flags of [planFlags, ["--plan", plan, "--plan-pr", "GC2"]]) {
        const result = await planGate(
          [verdictWith(perfSkipped())],
          [...flags, ...waive("perf=covered by GC4", "live-1=not needed")]
        );
        expect(result.exit).toBe(2);
        expect(result.out).toContain("does not skip box live-1");
        expect(result.out).not.toContain("box perf");
        expect(merged(result.calls)).toBe(false);
        expect(result.calls.some((call) => call.startsWith("comment "))).toBe(false);
        expect(result.log()).toContain("\terror\tusage: --accept-skip live-1: the verdict");
      }
    });

    it("refuses n/a without a reason and a box line it cannot read", async () => {
      const lines = allDone().map((line) =>
        line === "box live-3: done"
          ? "box live-3: n/a"
          : line === "box live-4: done"
            ? "box live-4: passed"
            : line
      );
      const result = await planGate([verdictWith(lines)]);
      expect(result.exit).toBe(1);
      expect(result.out).toContain("  no reason: live-3");
      expect(result.out).toContain("  unread: box live-4: passed");
    });

    const perfChanged = (note: string) =>
      allDone().map((line) => (line === "box perf: done" ? `box perf: changed. ${note}` : line));

    it("counts a changed box that names who accepted it and why, and lists it on the merge", async () => {
      const result = await planGate(
        [verdictWith(perfChanged("Lee, 14 of 8,190 arrivals off-slot are LIM-193"))],
        ["--plan", plan, "--plan-pr", "GC2"]
      );
      expect(result.exit).toBe(0);
      expect(result.out).toStartWith("MERGED: ");
      expect(result.out).toContain(
        "met: Plan boxes (all 16 required boxes of GC2 listed, 1 bar changed)\n  changed: box perf, accepted by Lee: 14 of 8,190 arrivals off-slot are LIM-193\n"
      );
    });

    it("refuses a changed box with no who and why", async () => {
      for (const note of ["", "Lee", "Lee,", ", the bar moved"]) {
        const lines = note === ""
          ? allDone().map((line) => (line === "box perf: done" ? "box perf: changed" : line))
          : perfChanged(note);
        const result = await planGate([verdictWith(lines)]);
        expect(result.exit).toBe(1);
        expect(result.missing[0]).toContain(
          'Plan boxes. 1 changed box does not name who accepted the changed bar and why. Have the verifier write "box <id>: changed. <who>, <why>"'
        );
        expect(result.out).toContain("  no who and why: perf");
      }
    });

    describe("a plan the PR body declares", () => {
      const declaring = (
        body: string,
        comments: readonly IssueComment[],
        flags: readonly string[] = ["--check"]
      ) =>
        gate(
          {
            pull: { headRefOid: repos.head, body: `Adds GC2.\n\n${body}\n` },
            comments: [...comments, codexComment(repos.head)],
          },
          flags
        );
      const inCheckout = () => {
        mkdirSync(join(repos.gate, "docs"), { recursive: true });
        writeFileSync(join(repos.gate, "docs", "plan.md"), readFileSync(plan, "utf8"));
        return join(repos.gate, "docs", "plan.md");
      };

      it("checks the declared plan when no --plan is passed", async () => {
        const refused = await declaring(`pstack-plan: ${plan} pr=GC2`, [verdictWith([])]);
        expect(refused.exit).toBe(1);
        expect(refused.out).toContain("The verdict omits 16 required boxes of GC2");

        const passed = await declaring(`pstack-plan: ${plan} pr=GC2`, [verdictWith(allDone())]);
        expect(passed.exit).toBe(0);
        expect(passed.out).toContain(
          "met: Plan boxes (all 16 required boxes of GC2 listed, from the plan the PR body declares)"
        );
      });

      it("resolves a relative declared path from the working directory, and agrees with its full path passed", async () => {
        const full = inCheckout();
        const declared = await declaring("pstack-plan: docs/plan.md pr=GC2", [verdictWith(allDone())]);
        expect(declared.exit).toBe(0);
        const passed = await declaring(
          "pstack-plan: docs/plan.md pr=GC2",
          [verdictWith(allDone())],
          ["--check", "--plan", full, "--plan-pr", "GC2"]
        );
        expect(passed.exit).toBe(0);
        expect(passed.out).toContain("met: Plan boxes (all 16 required boxes of GC2 listed)");
      });

      it("refuses a declared plan that is not on this machine and prints the flags to pass", async () => {
        const result = await declaring("pstack-plan: docs/elsewhere-plan.md pr=GC2", [verdictWith(allDone())]);
        expect(result.exit).toBe(1);
        expect(result.missing).toEqual([
          "missing: Plan boxes. The PR body declares the plan docs/elsewhere-plan.md for GC2, and it is not on this machine. Run the gate from where that path resolves, or pass the plan's path here:",
        ]);
        expect(result.out).toContain("\n  --plan docs/elsewhere-plan.md --plan-pr GC2\n");
      });

      it("refuses a passed plan that disagrees with the declared one and shows both", async () => {
        const full = inCheckout();
        for (const flags of [
          ["--plan", full, "--plan-pr", "GC3"],
          ["--plan", plan, "--plan-pr", "GC2"],
        ]) {
          const result = await declaring(
            "pstack-plan: docs/plan.md pr=GC2",
            [verdictWith(allDone())],
            ["--check", ...flags]
          );
          expect(result.exit).toBe(1);
          expect(result.missing[0]).toStartWith(
            "missing: Plan boxes. --plan and --plan-pr name another plan than the PR body declares."
          );
          expect(result.out).toContain("  declared: pstack-plan: docs/plan.md pr=GC2\n");
          expect(result.out).toContain(`  passed: --plan ${flags[1]} --plan-pr ${flags[3]}\n`);
        }
      });

      it("reads a declared plan whose path has spaces, and refuses a plan line it cannot read", async () => {
        const dir = join(mkdtempSync(join(tmpdir(), "merge-gate-spaced-")), "Project Plans");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "plan.md"), readFileSync(plan, "utf8"));
        const spaced = await declaring(`pstack-plan: ${join(dir, "plan.md")} pr=GC2`, [verdictWith([])]);
        expect(spaced.exit).toBe(1);
        expect(spaced.out).toContain("The verdict omits 16 required boxes of GC2");
        const malformed = await declaring(`pstack-plan: ${join(dir, "plan.md")}`, [verdictWith(allDone())]);
        expect(malformed.exit).toBe(2);
        expect(malformed.out).toContain("does not read as one pstack-plan: <plan file> pr=<PR id> line");
        const twice = await declaring(
          `pstack-plan: ${join(dir, "plan.md")} pr=GC2\n\n\`\`\`\npstack-plan: ${plan} pr=GC2\n\`\`\``,
          [verdictWith(allDone())]
        );
        expect(twice.exit).toBe(2);
        expect(twice.out).toContain("2 plan lines");
      });

      it("refuses a stale copy whose path ends like the declared plan", async () => {
        inCheckout();
        const stale = join(mkdtempSync(join(tmpdir(), "merge-gate-stale-")), "docs");
        mkdirSync(stale, { recursive: true });
        writeFileSync(join(stale, "plan.md"), readFileSync(plan, "utf8"));
        const result = await declaring(
          "pstack-plan: docs/plan.md pr=GC2",
          [verdictWith(allDone())],
          ["--check", "--plan", join(stale, "plan.md"), "--plan-pr", "GC2"]
        );
        expect(result.exit).toBe(1);
        expect(result.missing[0]).toStartWith(
          "missing: Plan boxes. --plan and --plan-pr name another plan than the PR body declares."
        );
      });

      it("says plainly when no plan was checked, and still passes", async () => {
        const result = await declaring("", [verdictWith([])]);
        expect(result.exit).toBe(0);
        expect(result.out).toContain(
          "met: Plan boxes (no plan given, 0 boxes listed)\n  No plan checked: the PR declares none and none was passed.\n"
        );
      });
    });

    it("checks skips even with no plan given", async () => {
      const result = await planGate(
        [verdictWith(["box perf: skipped. Not run."])],
        ["--check"]
      );
      expect(result.exit).toBe(1);
      expect(result.out).toContain("  not accepted: perf");
      expect((await planGate([verdictWith([])], ["--check"])).out).toContain(
        "met: Plan boxes (no plan given, 0 boxes listed)"
      );
    });

    it("exits 2 when the plan has no section for the PR id, or --plan comes alone", async () => {
      const unknown = await planGate(
        [verdictWith(allDone())],
        ["--check", "--plan", plan, "--plan-pr", "GC9"]
      );
      expect(unknown.exit).toBe(2);
      expect(unknown.out).toContain('has no section whose title ends with "(GC9)"');
      const alone = await planGate([verdictWith(allDone())], ["--check", "--plan", plan]);
      expect(alone.exit).toBe(2);
      expect(alone.out).toContain("--plan and --plan-pr go together");
    });
  });

  describe("shortcuts", () => {
    const carried =
      "shortcut live-1: not rerun; carries the passing lane from the verdict at 9f7e294. Only features/README.md changed, which the lane does not run.";
    const withShortcuts = (...lines: string[]) =>
      comment(
        `pstack-verdict: PASS head=${repos.head} base=${repos.main} by=codex/gpt-6.1-sol\n\nGates rerun at this head.\n${lines.join("\n")}`
      );
    const shortcutGate = (verdict: IssueComment, flags: readonly string[]) =>
      gate({ comments: [verdict, codexComment(repos.head)] }, flags);
    const accept = (...values: string[]) =>
      values.flatMap((value) => ["--accept-shortcut", value]);

    it("says none were listed when the verdict lists none", async () => {
      const result = await gate();
      expect(result.out).toContain("met: Shortcuts (none listed)");
    });

    it("refuses a shortcut the lead has not accepted, with or without a plan", async () => {
      const result = await shortcutGate(withShortcuts(carried), ["--check"]);
      expect(result.exit).toBe(1);
      expect(result.missing[0]).toContain(
        'missing: Shortcuts. 1 shortcut is not accepted by the lead. Rerun what it skipped and get a new verdict, or, if the lead accepts it, the lead runs the gate with "--accept-shortcut <id>=<reason>"'
      );
      expect(result.out).toContain(`  not accepted: ${carried}`);
    });

    it("merges once the lead accepts each shortcut, posting and logging the acceptance", async () => {
      const verdict = withShortcuts(carried, "- shortcut perf: not rerun; carries perf from 9f7e294. No code the probe runs changed.");
      const half = await shortcutGate(verdict, ["--check", ...accept("live-1=docs only")]);
      expect(half.exit).toBe(1);
      expect(half.out).toContain("  not accepted: shortcut perf: not rerun");
      const result = await shortcutGate(verdict, accept("live-1=docs only", "perf=the probe's code is unchanged"));
      expect(result.exit).toBe(0);
      expect(result.out).toContain(
        `met: Shortcuts (2 accepted by the lead)\n  ${carried} Accepted: docs only\n`
      );
      expect(result.calls.find((call) => call.startsWith("comment "))).toBe(
        `comment owner/repo#1 merge-gate: the lead accepted these shortcuts the verdict ${verdict.url} lists to merge ${repos.head}.\n\n- live-1: docs only\n- perf: the probe's code is unchanged`
      );
      expect(result.log().split("\n")[1]).toEndWith(
        `\tmerge\tmerged\t\t[{"kind":"shortcut","id":"live-1","reason":"docs only"},{"kind":"shortcut","id":"perf","reason":"the probe's code is unchanged"}]`
      );
    });

    it("refuses a shortcut line it cannot read, and one listed twice", async () => {
      const result = await shortcutGate(
        withShortcuts(carried, carried, "shortcut Live 1: not rerun"),
        ["--check", ...accept("live-1=docs only")]
      );
      expect(result.exit).toBe(1);
      expect(result.out).toContain("  listed more than once: live-1");
      expect(result.out).toContain("  unread: shortcut Live 1: not rerun");
    });

    it("exits 2 on an --accept-shortcut the verdict does not list, and on one with no reason", async () => {
      const stray = await shortcutGate(withShortcuts(carried), ["--check", ...accept("live-1=docs only", "perf=unchanged")]);
      expect(stray.exit).toBe(2);
      expect(stray.out).toContain("--accept-shortcut perf: the verdict");
      expect(stray.out).toContain("lists no shortcut perf");
      const bare = await shortcutGate(withShortcuts(carried), ["--check", ...accept("live-1")]);
      expect(bare.exit).toBe(2);
      expect(bare.out).toContain("shortcut live-1 needs a reason: --accept-shortcut live-1=<reason>");
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

    it("an edit to an older completed summary does not hide a newer pending review", async () => {
      const done = codexComment(repos.head);
      const pending = codexComment(repos.head, "in_progress");
      const result = await gate({
        comments: [
          verdictComment("PASS", repos.head, repos.main),
          { ...done, updatedAt: "2026-06-01T00:00:00.000Z" },
          pending,
        ],
      });
      expect(result.exit).toBe(1);
      expect(result.missing[0]).toContain("is in_progress, not completed");
    });

    it("breaks a same-second tie toward the later Codex comment", async () => {
      const done = codexComment(repos.head);
      const pending = {
        ...codexComment(repos.head, "in_progress"),
        createdAt: done.createdAt,
        updatedAt: done.updatedAt,
      };
      const result = await gate({
        comments: [
          verdictComment("PASS", repos.head, repos.main),
          done,
          pending,
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
    const approvedIn = "approved-in: 55835e2a-d498-4643-95ce-a3a0eb4f736b";
    const withHead = (
      head: string,
      ...extra: ReturnType<typeof comment>[]
    ) => ({
      pull: { headRefOid: head },
      comments: [...approvals(head), ...extra],
    });

    it("refuses an AGENTS.md or CLAUDE.md change without approval and prints the lines to post", async () => {
      const result = await gate(withHead(repos.instructionHead));
      expect(result.exit).toBe(1);
      expect(result.missing[0]).toContain(
        "The PR changes AGENTS.md, sub/Claude.md."
      );
      expect(result.out).toContain(
        `\n  lee-approves-instruction-files: ${approvalHash(repos.instructionHead)}\n`
      );
    });

    it("is met when Lee approved this exact text in a T3 thread", async () => {
      const result = await gate(
        withHead(
          repos.instructionHead,
          comment(
            `lee-approves-instruction-files: ${approvalHash(repos.instructionHead)}\n${approvedIn}\n> yes, ship that exact text`
          )
        )
      );
      expect(result.exit).toBe(0);
      expect(result.out).toContain("met: Instruction-file approval");
    });

    it("refuses the hash line without the approved-in line", async () => {
      const result = await gate(
        withHead(
          repos.instructionHead,
          comment(
            `lee-approves-instruction-files: ${approvalHash(repos.instructionHead)}`
          )
        )
      );
      expect(result.exit).toBe(1);
      expect(result.out).toContain("\n  approved-in: <T3 thread id>\n");
    });

    it("refuses the two lines split across comments", async () => {
      const result = await gate(
        withHead(
          repos.instructionHead,
          comment(
            `lee-approves-instruction-files: ${approvalHash(repos.instructionHead)}`
          ),
          comment(approvedIn)
        )
      );
      expect(result.exit).toBe(1);
    });

    it("refuses new text approved only for the old text", async () => {
      const old = comment(
        `lee-approves-instruction-files: ${approvalHash(repos.instructionHead)}\n${approvedIn}`
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

    it("does not count an approval line from an account that is not an owner, member or collaborator", async () => {
      const outsider = comment(
        `lee-approves-instruction-files: ${approvalHash(repos.instructionHead)}\n${approvedIn}`,
        "drive-by",
        false,
        "CONTRIBUTOR"
      );
      const result = await gate(withHead(repos.instructionHead, outsider));
      expect(result.exit).toBe(1);
      expect(result.missing[0]).toContain("Instruction-file approval");
    });

    it("does not count an approval line posted by a bot", async () => {
      const bot = comment(
        `lee-approves-instruction-files: ${approvalHash(repos.instructionHead)}\n${approvedIn}`,
        "some-app[bot]",
        true,
        "MEMBER"
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

    it("exits 2 when the gate's own clone cannot fetch the repo", async () => {
      const github = fakeGitHub({ pull: { headRefOid: repos.head } });
      const runtime = runtimeFor(github, repos.gate);
      const exit = await withGitConfig(
        { [`url.${repos.remote}-missing.insteadOf`]: "https://github.com/other/repo" },
        () => main(["--repo", "other/repo", "--pr", "1"], runtime)
      );
      expect(exit).toBe(2);
      expect(runtime.decision()).toStartWith("ERROR: other/repo#1\n");
      expect(merged(github.calls)).toBe(false);
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

    it("says plainly when the merge landed in another base", async () => {
      const result = await gate({ readBack: { baseRefName: "parent" } }, []);
      expect(result.exit).toBe(1);
      expect(result.out).toStartWith(
        `MERGED INTO THE WRONG BASE: owner/repo#1 at ${repos.head.slice(0, 7)} into parent, not main\n`
      );
      expect(result.out).not.toContain("NOT MERGED");
      expect(result.out).toContain("Tell Lee");
      expect(result.log()).toContain("\tmerge\twrong-base\t");
    });

    it("says plainly when someone else merged the PR while the gate's merge failed", async () => {
      const result = await gate(
        {
          merge: { ok: false, detail: "Pull request is already merged" },
          readBack: { state: "MERGED" },
        },
        []
      );
      expect(result.exit).toBe(1);
      expect(result.out).toStartWith(
        `MERGED, BUT NOT BY THE GATE: owner/repo#1 at ${repos.head.slice(0, 7)} into main`
      );
      expect(result.out).not.toContain("NOT MERGED");
      expect(result.log()).toContain("\tmerge\tmerged-elsewhere\t");
    });

    it("merges nothing when the PR was retargeted after evaluation", async () => {
      const result = await gate(
        { atMerge: { pull: { baseRefName: "parent" } } },
        []
      );
      expect(result.exit).toBe(1);
      expect(merged(result.calls)).toBe(false);
      expect(result.out).toStartWith(
        `NOT MERGED: owner/repo#1 at ${repos.head.slice(0, 7)}\n`
      );
      expect(result.out).toContain("targets parent, not main");
      expect(result.log()).toContain("\tmerge\trefused\t");
    });

    it("merges nothing when the head moved after evaluation", async () => {
      const result = await gate(
        { atMerge: { pull: { headRefOid: repos.changedHead } } },
        []
      );
      expect(result.exit).toBe(1);
      expect(merged(result.calls)).toBe(false);
      expect(result.out).toContain(repos.changedHead.slice(0, 7));
    });

    it("merges nothing when a review thread opened after evaluation", async () => {
      const result = await gate(
        {
          atMerge: {
            threads: [
              {
                author: "reviewer",
                path: "a.txt",
                line: 1,
                body: "Wait, this breaks the empty case",
                url: "https://github.com/owner/repo/pull/1#discussion_r11",
              },
            ],
          },
        },
        []
      );
      expect(result.exit).toBe(1);
      expect(merged(result.calls)).toBe(false);
      expect(result.out).toStartWith(
        `NOT MERGED: owner/repo#1 at ${repos.head.slice(0, 7)}\n`
      );
      expect(result.out).toContain("missing: Review threads. 1 unresolved.");
      expect(result.log()).toContain("\tmerge\trefused\tReview threads");
    });

    it("merges nothing when a newer FAIL verdict lands after evaluation", async () => {
      const result = await gate(
        {
          atMerge: {
            comments: [
              ...approvals(),
              verdictComment("FAIL", repos.head, repos.main),
            ],
          },
        },
        []
      );
      expect(result.exit).toBe(1);
      expect(merged(result.calls)).toBe(false);
      expect(result.out).toContain("The latest verdict is FAIL");
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
      "ts\trepo\tpr\thead\tmode\toutcome\tmissing\twaived",
      `2026-10-17T12:00:00.000Z\towner/repo\t1\t${repos.head}\tcheck\trefused\tChecks\t`,
      "",
    ]);
  });

  it("adds the waived column to a run log written before it", async () => {
    const github = fakeGitHub({ comments: approvals(), pull: { headRefOid: repos.head } });
    const runtime = runtimeFor(github, repos.gate);
    const file = join(runtime.store, "merge-gate", "runs.tsv");
    const old = "2026-10-01T00:00:00.000Z\towner/repo\t1\tabc\tcheck\trefused\tChecks\n";
    mkdirSync(join(runtime.store, "merge-gate"));
    writeFileSync(file, `ts\trepo\tpr\thead\tmode\toutcome\tmissing\n${old}`);
    await main(["--repo", REPO, "--pr", "1", "--check"], runtime);
    const rows = readFileSync(file, "utf8").split("\n");
    expect(rows.slice(0, 2)).toEqual([
      "ts\trepo\tpr\thead\tmode\toutcome\tmissing\twaived",
      old.trimEnd(),
    ]);
    expect(rows[2]).toEndWith("\tcheck\twould-merge\t\t");
  });

  it("logs a passing --check as would-merge, not merged", async () => {
    const result = await gate();
    expect(result.exit).toBe(0);
    expect(result.log()).toContain("\tcheck\twould-merge\t");
  });

  describe("--repo from a directory with no clone of the repo", () => {
    const fromElsewhere = async (cwd: string, store?: string) => {
      const github = fakeGitHub({
        comments: approvals(),
        pull: { headRefOid: repos.head },
      });
      const runtime = { ...runtimeFor(github, cwd), ...(store ? { store } : {}) };
      const exit = await withGitConfig(
        {
          [`url.${repos.remote.slice(0, -".git".length)}.insteadOf`]:
            "https://github.com/owner/repo",
        },
        () => main(["--repo", REPO, "--pr", "1", "--check"], runtime)
      );
      return { exit, out: runtime.decision(), store: runtime.store };
    };

    it("keeps a bare clone of the repo under the store and judges from it", async () => {
      const first = await fromElsewhere(mkdtempSync(join(tmpdir(), "merge-gate-cwd-")));
      expect(first.exit).toBe(0);
      expect(first.out).toStartWith(`WOULD MERGE: owner/repo#1 at ${repos.head.slice(0, 7)}`);
      const clone = join(first.store, "merge-gate", "repos", "owner", "repo.git");
      expect(repos.git(clone, "rev-parse", "--is-bare-repository")).toBe("true");
      expect(repos.git(clone, "config", "remote.origin.url")).toBe(
        "https://github.com/owner/repo.git"
      );
      expect(repos.git(clone, "cat-file", "-t", repos.head)).toBe("commit");

      const again = await fromElsewhere(mkdtempSync(join(tmpdir(), "merge-gate-cwd-")), first.store);
      expect(again.exit).toBe(0);
    });

    it("uses the store's clone from a clone of another repo", async () => {
      const other = mkdtempSync(join(tmpdir(), "merge-gate-other-"));
      repos.git(other, "init", "--quiet");
      repos.git(other, "remote", "add", "origin", "https://github.com/other/repo.git");
      const result = await fromElsewhere(other);
      expect(result.exit).toBe(0);
      expect(
        repos.git(join(result.store, "merge-gate", "repos", "owner", "repo.git"), "cat-file", "-t", repos.head)
      ).toBe("commit");
    });
  });

  it("defaults --repo to the origin remote's repo", async () => {
    const github = fakeGitHub({
      comments: approvals(),
      pull: { headRefOid: repos.head },
    });
    const runtime = runtimeFor(github, repos.gate);
    expect(await main(["--pr", "1", "--check"], runtime)).toBe(0);
    expect(github.calls.slice(0, 2)).toEqual([
      "mergeBrief owner/repo",
      "defaultBranch owner/repo",
    ]);
  });

  it("logs a usage error with whatever context it has", async () => {
    const runtime = runtimeFor(
      fakeGitHub({ pull: { headRefOid: "x" } }),
      repos.gate
    );
    expect(
      await main(
        ["--repo", "owner/repo", "--pr", "15", "--check", "--badflag"],
        runtime
      )
    ).toBe(2);
    expect(await main(["--pr", "abc"], runtime)).toBe(2);
    const rows = readFileSync(
      join(runtime.store, "merge-gate", "runs.tsv"),
      "utf8"
    )
      .split("\n")
      .slice(1, -1)
      .map((row) => row.split("\t").slice(1));
    expect(rows).toEqual([
      [
        "owner/repo",
        "15",
        "",
        "check",
        "error",
        "usage: unknown option '--badflag'",
        "",
      ],
      [
        "",
        "abc",
        "",
        "merge",
        "error",
        expect.stringMatching(/^usage: .*--pr/),
        "",
      ],
    ]);
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
  describe("waived gate checks", () => {
    const reason = "the e2e runner is down, LIM-200; Lee ran the suite locally";

    it("names the --waive flag under each missing check a lead may waive, and none under the verdict", async () => {
      const result = await gate({
        checks: [failing("e2e")],
        threads: [{ author: "r", path: null, line: null, body: "nit", url: null }],
        comments: [],
      });
      expect(result.exit).toBe(1);
      for (const check of ["checks", "threads", "codex"])
        expect(result.out).toContain(
          `  If the lead accepts merging without it, the lead runs the gate with --waive ${check}=<reason>.`
        );
      expect(result.out.match(/--waive /g)).toHaveLength(3);
      expect(result.out).toContain("missing: Independent verdict.");
    });

    it("would merge with a missing check the lead waives, and posts nothing under --check", async () => {
      const result = await gate({ checks: [failing("e2e")] }, ["--check", "--waive", `checks=${reason}`]);
      expect(result.exit).toBe(0);
      expect(result.out).toContain(
        `met: Checks (waived by the lead: ${reason}; unmet: 1 failed (e2e). Fix the failures and push.)`
      );
      expect(result.calls.some((call) => call.startsWith("comment "))).toBe(false);
      expect(result.log().split("\n")[1]).toEndWith(
        `\tcheck\twould-merge\t\t[{"kind":"waiver","id":"checks","reason":"${reason}"}]`
      );
    });

    it("posts the waived checks on the PR before it merges, and logs them", async () => {
      const result = await gate(
        { checks: [failing("e2e")], comments: [verdictComment("PASS", repos.head, repos.main)] },
        ["--waive", `checks=${reason}`, "--waive", "codex=Codex is out of quota today"]
      );
      expect(result.exit).toBe(0);
      const posted = result.calls.findIndex((call) => call.startsWith("comment "));
      expect(result.calls[posted]).toBe(
        `comment owner/repo#1 merge-gate: the lead waived these missing gate checks to merge ${repos.head}.\n\n- checks: ${reason}\n- codex: Codex is out of quota today`
      );
      expect(posted).toBeLessThan(result.calls.findIndex((call) => call.startsWith("merge ")));
      expect(result.log().split("\n")[1]).toEndWith(
        `\tmerge\tmerged\t\t[{"kind":"waiver","id":"checks","reason":"${reason}"},{"kind":"waiver","id":"codex","reason":"Codex is out of quota today"}]`
      );
    });

    it("exits 2 on a --waive for a check that holds", async () => {
      const result = await gate({}, ["--waive", "threads=nothing open anyway"]);
      expect(result.exit).toBe(2);
      expect(result.out).toContain("--waive threads: Review threads is met, so there is nothing to waive");
      expect(merged(result.calls)).toBe(false);
      expect(result.log()).toContain("\terror\tusage: --waive threads: Review threads is met");
    });

    it("exits 2 on a --waive for a check no lead may waive, or with no reason", async () => {
      for (const [value, text] of [
        ["verdict=the verifier is slow", '"verdict" is not a check the lead may waive. Waivable: checks, threads, codex.'],
        ["instruction=Lee is away", '"instruction" is not a check the lead may waive'],
        ["checks=", "check checks needs a reason: --waive checks=<reason>"],
      ] as const) {
        const result = await gate({ checks: [failing()] }, ["--waive", value]);
        expect(result.exit).toBe(2);
        expect(result.full).toContain(text);
        expect(merged(result.calls)).toBe(false);
      }
    });

    it("merges nothing when a waived check holds by merge time", async () => {
      const result = await gate(
        { checks: [running("e2e")], atMerge: { checks: [passing("e2e")] } },
        ["--waive", `checks=${reason}`]
      );
      expect(result.exit).toBe(1);
      expect(result.out).toContain("something the run waives came to hold");
      expect(result.calls.some((call) => call.startsWith("comment "))).toBe(false);
      expect(merged(result.calls)).toBe(false);
    });
  });

  describe("merge brief", () => {
    it("prints the repo's merge brief first, on a check or a refusal", async () => {
      for (const options of [{}, { checks: [failing("build")] }]) {
        const result = await gate({
          ...options,
          mergeBrief: "# Merging owner/repo\n- Run the e2e suite first.\n",
        });
        expect(result.full).toStartWith(
          "Merge brief for owner/repo:\n# Merging owner/repo\n- Run the e2e suite first.\n\n"
        );
        expect(result.calls[0]).toBe("mergeBrief owner/repo");
      }
    });

    it("says the repo has no merge brief and what writes one", async () => {
      const result = await gate({ mergeBrief: null });
      expect(result.exit).toBe(0);
      expect(result.full).toStartWith(
        "owner/repo has no merge brief (.agents/merge-brief.md on its default branch). /create-verification-skill writes one.\n\nWOULD MERGE: "
      );
    });

    it("says the merge brief could not be read, and still merges", async () => {
      const result = await gate({ failOn: "mergeBrief" }, []);
      expect(result.exit).toBe(0);
      expect(result.full).toStartWith(
        "The merge brief for owner/repo (.agents/merge-brief.md) could not be read: unexpected error: mergeBrief failed\n\nMERGED: "
      );
      expect(merged(result.calls)).toBe(true);
    });
  });
});
