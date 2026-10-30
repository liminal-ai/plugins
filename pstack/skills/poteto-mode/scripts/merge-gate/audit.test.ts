import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.ts";
import { type FakeOptions, fakeGitHub, runtimeFor } from "./fakes.test-helper.ts";
import type { MergedPull } from "./github.ts";

const HEADER = "ts\trepo\tpr\thead\tmode\toutcome\tmissing\twaived";
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

const row = (repo: string, pr: number, head: string, outcome = "merged", mode = "merge") =>
  ["2026-10-16T00:00:00.000Z", repo, String(pr), head, mode, outcome, "", ""].join("\t");

const pull = (number: number, head: string, mergedBy: string | null = "leegmoore"): MergedPull => ({
  number,
  head,
  mergedBy,
  mergedAt: `2026-10-1${number}T01:00:00Z`,
});

async function runAudit(
  localRows: readonly string[] | null,
  mergedPulls: FakeOptions["mergedPulls"],
  flags: readonly string[] = [],
  options: Partial<FakeOptions> = {}
) {
  const github = fakeGitHub({ pull: { headRefOid: A }, mergedPulls, ...options });
  const runtime = runtimeFor(github, tmpdir());
  if (localRows !== null) {
    mkdirSync(join(runtime.store, "merge-gate"), { recursive: true });
    writeFileSync(join(runtime.store, "merge-gate", "runs.tsv"), `${[HEADER, ...localRows].join("\n")}\n`);
  }
  const exit = await main(["audit", ...flags], runtime);
  return { exit, out: runtime.out(), calls: github.calls, store: runtime.store };
}

describe("merge-gate audit", () => {
  it("lists the merge with no receipt, counts each repo, writes the TSV, and exits 1", async () => {
    const result = await runAudit(
      [row("owner/repo", 1, A), row("owner/repo", 2, B, "would-merge", "check"), row("owner/repo", 3, A)],
      { "owner/repo": [pull(1, A), pull(2, B, null), pull(3, C)] }
    );
    expect(result.exit).toBe(1);
    const file = join(result.store, "merge-gate", "audit", "2026-10-17-120000.tsv");
    expect(result.out).toBe(
      [
        "New merges since 2026-10-10 with no gate receipt:",
        "repo        PR  merged at             merged by  head",
        `owner/repo  #2  2026-10-12T01:00:00Z  (unknown)  ${B}`,
        `owner/repo  #3  2026-10-13T01:00:00Z  leegmoore  ${C}`,
        "",
        "owner/repo: 3 merges, 1 receipt, 2 without (2 new, 0 known, 0 historical)",
        `Wrote ${file}`,
        "",
      ].join("\n")
    );
    expect(readFileSync(file, "utf8")).toBe(
      [
        "repo\tpr\tmerged_at\tmerged_by\thead\treceipt\tgap\tnote",
        `owner/repo\t1\t2026-10-11T01:00:00Z\tleegmoore\t${A}\tyes\t\t`,
        `owner/repo\t2\t2026-10-12T01:00:00Z\t\t${B}\tno\tnew\t`,
        `owner/repo\t3\t2026-10-13T01:00:00Z\tleegmoore\t${C}\tno\tnew\t`,
        "",
      ].join("\n")
    );
    expect(result.calls).toEqual(["mergedPullRequests owner/repo 2026-10-10"]);
  });

  it("takes receipts from another machine's --log and exits 0 when every merge has one", async () => {
    const other = join(mkdtempSync(join(tmpdir(), "merge-gate-dgx-")), "runs.tsv");
    writeFileSync(other, `${HEADER}\n${row("Owner/Repo", 2, B)}\n`);
    const result = await runAudit(
      [row("owner/repo", 1, A)],
      { "owner/repo": [pull(1, A), pull(2, B)] },
      ["--log", other, "--since", "2026-10-01"]
    );
    expect(result.exit).toBe(0);
    expect(result.out).toStartWith(
      "Every merge since 2026-10-01 has a gate receipt.\n\nowner/repo: 2 merges, 2 receipts, 0 without\n"
    );
    expect(result.calls).toEqual(["mergedPullRequests owner/repo 2026-10-01"]);
  });

  it("audits each --repo, and by default every repo the local log names", async () => {
    const rows = [row("owner/repo", 1, A), row("other/repo", 4, A, "refused"), row("noslash", 9, "", "error")];
    const named = await runAudit(rows, {}, ["--repo", "third/repo"]);
    expect(named.calls).toEqual(["mergedPullRequests third/repo 2026-10-10"]);
    const all = await runAudit(rows, {});
    expect(all.exit).toBe(0);
    expect(all.calls).toEqual([
      "mergedPullRequests other/repo 2026-10-10",
      "mergedPullRequests owner/repo 2026-10-10",
    ]);
    expect(all.out).toContain("other/repo: 0 merges, 0 receipts, 0 without\nowner/repo: 0 merges");
  });

  it("exits 2 when GitHub or a --log cannot be read, and on bad usage", async () => {
    const github = await runAudit([row("owner/repo", 1, A)], {}, [], { failOn: "mergedPullRequests" });
    expect(github.exit).toBe(2);
    expect(github.out).toStartWith("ERROR: the merge audit could not read everything it needs: ");
    const log = await runAudit(null, {}, ["--repo", "owner/repo", "--log", "/nonexistent/runs.tsv"]);
    expect(log.exit).toBe(2);
    expect(log.out).toContain("the run log /nonexistent/runs.tsv could not be read");
    expect(log.calls).toEqual([]);
    expect((await runAudit(null, {}, ["--since", "last week"])).exit).toBe(2);
    expect((await runAudit(null, {}, ["--repo", "noslash"])).exit).toBe(2);
  });

  it("says so when there is no repo to audit", async () => {
    const result = await runAudit(null, {});
    expect(result.exit).toBe(0);
    expect(result.out).toStartWith("No repos to audit: this machine's runs.tsv names none. Pass --repo <owner/name>.\n");
  });

  it("gives a second audit in the same second its own file", async () => {
    const github = fakeGitHub({ pull: { headRefOid: A }, mergedPulls: { "owner/repo": [pull(1, A)] } });
    const runtime = runtimeFor(github, tmpdir());
    expect(await main(["audit", "--repo", "owner/repo"], runtime)).toBe(1);
    expect(await main(["audit", "--repo", "owner/repo"], runtime)).toBe(1);
    const dir = join(runtime.store, "merge-gate", "audit");
    expect(readdirSync(dir).sort()).toEqual(["2026-10-17-120000-2.tsv", "2026-10-17-120000.tsv"]);
    expect(runtime.out()).toContain(`Wrote ${join(dir, "2026-10-17-120000-2.tsv")}`);
  });

  it("lists new gaps apart from --known ones and --historical ones, and a known one with a receipt as receipted", async () => {
    const D = "d".repeat(40);
    const result = await runAudit(
      [row("owner/repo", 1, A)],
      { "owner/repo": [pull(1, A), pull(2, B), pull(3, C), pull(4, D)] },
      ["--known", `Owner/Repo#1@${A}`, "--known", `owner/repo#2@${B}`, "--historical", `owner/repo#3@${C}=before the gate\tran`]
    );
    expect(result.exit).toBe(1);
    const file = join(result.store, "merge-gate", "audit", "2026-10-17-120000.tsv");
    expect(result.out).toBe(
      [
        "New merges since 2026-10-10 with no gate receipt:",
        "repo        PR  merged at             merged by  head",
        `owner/repo  #4  2026-10-14T01:00:00Z  leegmoore  ${D}`,
        "Known gaps, still with no gate receipt:",
        "repo        PR  merged at             merged by  head",
        `owner/repo  #2  2026-10-12T01:00:00Z  leegmoore  ${B}`,
        "Historical, no gate receipt:",
        "repo        PR  merged at             merged by  head                                      reason",
        `owner/repo  #3  2026-10-13T01:00:00Z  leegmoore  ${C}  before the gate ran`,
        "",
        "owner/repo: 4 merges, 1 receipt, 3 without (1 new, 1 known, 1 historical)",
        `Wrote ${file}`,
        "",
      ].join("\n")
    );
    expect(readFileSync(file, "utf8").split("\n").slice(2, 4)).toEqual([
      `owner/repo\t2\t2026-10-12T01:00:00Z\tleegmoore\t${B}\tno\tknown\t`,
      `owner/repo\t3\t2026-10-13T01:00:00Z\tleegmoore\t${C}\tno\thistorical\tbefore the gate ran`,
    ]);
  });

  it("matches a known gap by head too, and names a known gap it did not see", async () => {
    const result = await runAudit(
      [],
      { "owner/repo": [pull(2, B)] },
      ["--repo", "owner/repo", "--known", `owner/repo#2@${C}`, "--known", `other/repo#5@${C}`]
    );
    expect(result.exit).toBe(1);
    expect(result.out).toContain(`New merges since 2026-10-10 with no gate receipt:\n`);
    expect(result.out).toContain(
      `Known gaps not among the merges since 2026-10-10 (a wrong PR or head, or an older merge):\n  owner/repo#2@${C}\n\n`
    );
    expect(result.out).not.toContain("other/repo#5");
  });

  it("exits 0 when every gap is historical", async () => {
    const result = await runAudit([], { "owner/repo": [pull(2, B)] }, [
      "--repo",
      "owner/repo",
      "--historical",
      `owner/repo#2@${B}=predates the guard`,
    ]);
    expect(result.exit).toBe(0);
    expect(result.out).toStartWith("No new merge without a gate receipt since 2026-10-10.\nHistorical, no gate receipt:\n");
  });

  it("keeps the window back to the oldest gap the newest earlier audit left unresolved", async () => {
    const github = fakeGitHub({ pull: { headRefOid: A }, mergedPulls: { "owner/repo": [pull(1, A)] } });
    const runtime = runtimeFor(github, tmpdir());
    const dir = join(runtime.store, "merge-gate", "audit");
    mkdirSync(dir, { recursive: true });
    const header = "repo\tpr\tmerged_at\tmerged_by\thead\treceipt";
    const audits: Record<string, string[]> = {
      "2026-09-01-060000.tsv": [
        `owner/repo\t7\t2026-08-20T01:00:00Z\tx\t${B}\tno`,
        `owner/repo\t8\t2026-08-25T01:00:00Z\tx\t${C}\tno`,
      ],
      "2026-09-02-060000.tsv": [`owner/repo\t7\t2026-08-20T01:00:00Z\tx\t${B}\tyes`],
      "2026-09-03-060000.tsv": [`other/repo\t3\t2026-08-01T01:00:00Z\tx\t${A}\tno`],
    };
    for (const [name, rows] of Object.entries(audits)) writeFileSync(join(dir, name), `${[header, ...rows].join("\n")}\n`);
    expect(await main(["audit", "--repo", "owner/repo"], runtime)).toBe(1);
    expect(runtime.out()).toStartWith(
      "The window starts 2026-08-25, not 2026-10-10, to keep the gaps an earlier audit left unresolved.\n"
    );
    expect(github.calls).toEqual(["mergedPullRequests owner/repo 2026-08-25"]);

    const settled = fakeGitHub({ pull: { headRefOid: A }, mergedPulls: {} });
    const later = { ...runtimeFor(settled, tmpdir()), store: runtime.store };
    await main(["audit", "--repo", "owner/repo", "--historical", `owner/repo#8@${C}=predates the gate`], later);
    expect(settled.calls).toEqual(["mergedPullRequests owner/repo 2026-10-10"]);
  });

  it("reads same-second audit files in the order they were written", async () => {
    const github = fakeGitHub({ pull: { headRefOid: A }, mergedPulls: {} });
    const runtime = runtimeFor(github, tmpdir());
    const dir = join(runtime.store, "merge-gate", "audit");
    mkdirSync(dir, { recursive: true });
    const header = "repo\tpr\tmerged_at\tmerged_by\thead\treceipt";
    const gap = (receipt: string) => `${header}\nowner/repo\t7\t2026-08-20T01:00:00Z\tx\t${B}\t${receipt}\n`;
    writeFileSync(join(dir, "2026-09-01-060000.tsv"), gap("no"));
    writeFileSync(join(dir, "2026-09-01-060000-2.tsv"), gap("no"));
    writeFileSync(join(dir, "2026-09-01-060000-10.tsv"), gap("yes"));
    await main(["audit", "--repo", "owner/repo"], runtime);
    expect(github.calls).toEqual(["mergedPullRequests owner/repo 2026-10-10"]);
  });

  it("names unreachable hosts first", async () => {
    const result = await runAudit([row("owner/repo", 1, A)], { "owner/repo": [pull(1, A)] }, [
      "--unreachable",
      "m5",
      "--unreachable",
      "spark2",
    ]);
    expect(result.out).toStartWith(
      "Unreachable, receipts not read: m5, spark2. A merge gated there shows below as a gap.\nEvery merge since 2026-10-10 has a gate receipt.\n"
    );
  });

  it("refuses a malformed --known and a --historical with no reason", async () => {
    expect((await runAudit(null, {}, ["--known", "owner/repo#2"])).exit).toBe(2);
    expect((await runAudit(null, {}, ["--known", `owner/repo#2@${B.slice(0, 7)}`])).exit).toBe(2);
    expect((await runAudit(null, {}, ["--historical", `owner/repo#2@${B}`])).exit).toBe(2);
    expect((await runAudit(null, {}, ["--historical", `owner/repo#2@${B}=  `])).exit).toBe(2);
  });
});
