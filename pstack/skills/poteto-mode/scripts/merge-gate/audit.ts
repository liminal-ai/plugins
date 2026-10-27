import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import type { Repository } from "../watch-pr/types.ts";
import { EXIT, type Runtime, message, parseRepo, runLog } from "./cli.ts";
import { ReadError } from "./git.ts";
import type { MergedPull } from "./github.ts";

interface AuditOptions {
  readonly repos: readonly Repository[];
  readonly since: string;
  readonly logs: readonly string[];
}

/** One gate run log row's identity, for matching a merge to the run that made it. */
const receiptKey = (repo: string, pr: string, head: string): string =>
  `${repo.toLowerCase()}#${pr}@${head}`;

const DAY_MS = 24 * 60 * 60 * 1000;

function parseSince(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))
    throw new InvalidArgumentError("must be a date, YYYY-MM-DD");
  return value;
}

function parseAuditArgs(
  argv: readonly string[],
  runtime: Runtime
): AuditOptions {
  const program = new Command("merge-gate audit")
    .description(
      "List PRs merged without a gate receipt: a runs.tsv row with the same repo, PR and head whose outcome is merged.\nRead-only on GitHub. Writes the result to its own file, <store>/merge-gate/audit/<YYYY-MM-DD>-<HHMMSS>.tsv (UTC).\nExit 0 every merge has a receipt, 1 any lacks one, 2 usage or read error."
    )
    .configureOutput({ writeOut: runtime.stdout, writeErr: runtime.stderr })
    .exitOverride()
    .option(
      "--repo <owner/name>",
      "a repo to audit; repeatable (default: every repo in this machine's runs.tsv)",
      (value: string, previous: readonly Repository[]) => [
        ...previous,
        parseRepo(value),
      ],
      []
    )
    .option(
      "--since <YYYY-MM-DD>",
      "audit merges on or after this UTC date (default: 7 days ago)",
      parseSince
    )
    .option(
      "--log <runs.tsv>",
      "another gate run log to take receipts from, such as another machine's; repeatable",
      (value: string, previous: readonly string[]) => [...previous, value],
      []
    );
  program.parse(argv, { from: "user" });
  const raw = program.opts<{
    repo: Repository[];
    since?: string;
    log: string[];
  }>();
  return {
    repos: raw.repo,
    since:
      raw.since ??
      new Date(runtime.now().getTime() - 7 * DAY_MS).toISOString().slice(0, 10),
    logs: raw.log,
  };
}

/** The rows of a run log by its header's column names. A missing local log has no rows. */
function readLog(path: string, missingOk: boolean): Record<string, string>[] {
  if (missingOk && !existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ReadError(
      `the run log ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const [header, ...rows] = text.split("\n").filter((line) => line !== "");
  const names = header?.split("\t") ?? [];
  for (const name of ["repo", "pr", "head", "outcome"])
    if (!names.includes(name))
      throw new ReadError(`the run log ${path} has no ${name} column`);
  return rows.map((row) => {
    const cells = row.split("\t");
    return Object.fromEntries(names.map((name, i) => [name, cells[i] ?? ""]));
  });
}

export async function audit(
  argv: readonly string[],
  runtime: Runtime
): Promise<number> {
  let options: AuditOptions;
  try {
    options = parseAuditArgs(argv, runtime);
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    return error.exitCode === 0 ? 0 : EXIT.error;
  }

  const results: {
    readonly repo: string;
    readonly merges: readonly MergedPull[];
    readonly without: readonly MergedPull[];
  }[] = [];
  try {
    const local = readLog(runLog(runtime.store), true);
    const rows = [
      ...local,
      ...options.logs.flatMap((path) => readLog(path, false)),
    ];
    const receipts = new Set(
      rows
        .filter((row) => row.outcome === "merged")
        .map((row) => receiptKey(row.repo, row.pr, row.head))
    );
    const repos =
      options.repos.length > 0
        ? options.repos
        : [...new Set(local.map((row) => row.repo))].sort().flatMap((repo) => {
            // A usage error logs the raw --repo, which may not name a repo at all.
            try {
              return [parseRepo(repo)];
            } catch {
              return [];
            }
          });
    for (const repo of repos) {
      const name = `${repo.owner}/${repo.repo}`;
      const merges = await runtime.github.mergedPullRequests(
        repo,
        options.since
      );
      results.push({
        repo: name,
        merges,
        without: merges.filter(
          (pull) =>
            !receipts.has(receiptKey(name, String(pull.number), pull.head))
        ),
      });
    }
  } catch (error) {
    runtime.stdout(
      `ERROR: the merge audit could not read everything it needs: ${message(error)}\n`
    );
    return EXIT.error;
  }

  const without = results.flatMap(({ repo, without }) =>
    without.map((pull) => ({ repo, ...pull }))
  );
  const out: string[] = [];
  if (results.length === 0)
    out.push(
      "No repos to audit: this machine's runs.tsv names none. Pass --repo <owner/name>."
    );
  else if (without.length === 0)
    out.push(`Every merge since ${options.since} has a gate receipt.`);
  else {
    const table = [
      ["repo", "PR", "merged at", "merged by", "head"],
      ...without.map((pull) => [
        pull.repo,
        `#${pull.number}`,
        pull.mergedAt,
        pull.mergedBy ?? "(unknown)",
        pull.head,
      ]),
    ];
    const widths = table[0].map((_, i) =>
      Math.max(...table.map((row) => row[i].length))
    );
    out.push(`Merges since ${options.since} with no gate receipt:`);
    for (const row of table)
      out.push(
        row
          .map((cell, i) => cell.padEnd(widths[i]))
          .join("  ")
          .trimEnd()
      );
  }
  out.push("");
  for (const { repo, merges, without: missing } of results) {
    const receipted = merges.length - missing.length;
    out.push(
      `${repo}: ${merges.length} merge${merges.length === 1 ? "" : "s"}, ${receipted} receipt${receipted === 1 ? "" : "s"}, ${missing.length} without`
    );
  }

  const stamp = runtime.now().toISOString();
  const name = `${stamp.slice(0, 10)}-${stamp.slice(11, 13)}${stamp.slice(14, 16)}${stamp.slice(17, 19)}`;
  const dir = join(runtime.store, "merge-gate", "audit");
  let file = join(dir, `${name}.tsv`);
  const tsv = [
    "repo\tpr\tmerged_at\tmerged_by\thead\treceipt",
    ...results.flatMap(({ repo, merges, without: missing }) =>
      merges.map((pull) =>
        [
          repo,
          pull.number,
          pull.mergedAt,
          pull.mergedBy ?? "",
          pull.head,
          missing.includes(pull) ? "no" : "yes",
        ].join("\t")
      )
    ),
  ];
  try {
    mkdirSync(dir, { recursive: true });
    // Each audit keeps its own file, so a second run in the same second never replaces the first's evidence.
    for (let n = 2; ; n++) {
      try {
        writeFileSync(file, `${tsv.join("\n")}\n`, { flag: "wx" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        file = join(dir, `${name}-${n}.tsv`);
      }
    }
  } catch (error) {
    runtime.stdout(
      `${out.join("\n")}\nERROR: the audit could not be written to ${file}: ${message(error)}\n`
    );
    return EXIT.error;
  }
  out.push(`Wrote ${file}`);
  runtime.stdout(`${out.join("\n")}\n`);
  return without.length === 0 ? 0 : 1;
}
