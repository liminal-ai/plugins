import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
  readonly known: ReadonlySet<string>;
  readonly historical: ReadonlyMap<string, string>;
  readonly unreachable: readonly string[];
}

/** One gate run log row's identity, for matching a merge to the run that made it. */
const receiptKey = (repo: string, pr: string, head: string): string =>
  `${repo.toLowerCase()}#${pr}@${head}`;

type Status = "receipted" | "new" | "known" | "historical";

const unresolved = (status: Status): boolean =>
  status === "new" || status === "known";

const DAY_MS = 24 * 60 * 60 * 1000;

function parseSince(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))
    throw new InvalidArgumentError("must be a date, YYYY-MM-DD");
  return value;
}

function parseGap(value: string): { key: string; reason: string | undefined } {
  const match = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)@([0-9a-f]{40})(?:=([\s\S]*))?$/.exec(value);
  if (match === null)
    throw new InvalidArgumentError("must be <owner/name>#<pr>@<full head sha>");
  return {
    key: receiptKey(match[1], match[2], match[3]),
    reason: match[4]?.replace(/\s+/g, " ").trim(),
  };
}

function parseAuditArgs(
  argv: readonly string[],
  runtime: Runtime
): AuditOptions {
  const program = new Command("merge-gate audit")
    .description(
      "List PRs merged without a gate receipt: a runs.tsv row with the same repo, PR and head whose outcome is merged.\nA gap is new unless --known or --historical names it. The window reaches back to the oldest new or known gap an earlier audit file left without a receipt, whatever --since says.\nRead-only on GitHub. Writes the result to its own file, <store>/merge-gate/audit/<YYYY-MM-DD>-<HHMMSS>.tsv (UTC).\nExit 0 every merge has a receipt or is historical, 1 any new or known gap, 2 usage or read error."
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
    )
    .option(
      "--known <owner/name#pr@head>",
      "a gap already reported and still unresolved, listed apart from new ones; repeatable",
      (value: string, previous: readonly string[]) => [...previous, parseGap(value).key],
      []
    )
    .option(
      "--historical <owner/name#pr@head=reason>",
      "a gap settled as never getting a receipt; listed as historical, never as receipted; repeatable",
      (value: string, previous: readonly [string, string][]): [string, string][] => {
        const { key, reason } = parseGap(value);
        if (!reason) throw new InvalidArgumentError("needs =<reason> after the head");
        return [...previous, [key, reason]];
      },
      []
    )
    .option(
      "--unreachable <host>",
      "a host whose run log could not be read, named next to the result; repeatable",
      (value: string, previous: readonly string[]) => [...previous, value],
      []
    );
  program.parse(argv, { from: "user" });
  const raw = program.opts<{
    repo: Repository[];
    since?: string;
    log: string[];
    known: string[];
    historical: [string, string][];
    unreachable: string[];
  }>();
  return {
    repos: raw.repo,
    since:
      raw.since ??
      new Date(runtime.now().getTime() - 7 * DAY_MS).toISOString().slice(0, 10),
    logs: raw.log,
    known: new Set(raw.known),
    historical: new Map(raw.historical),
    unreachable: raw.unreachable,
  };
}

function readTable(
  path: string,
  what: string,
  columns: readonly string[],
  missingOk: boolean
): Record<string, string>[] {
  if (missingOk && !existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ReadError(
      `${what} ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const [header, ...rows] = text.split("\n").filter((line) => line !== "");
  const names = header?.split("\t") ?? [];
  for (const name of columns)
    if (!names.includes(name))
      throw new ReadError(`${what} ${path} has no ${name} column`);
  return rows.map((row) => {
    const cells = row.split("\t");
    return Object.fromEntries(names.map((name, i) => [name, cells[i] ?? ""]));
  });
}

const readLog = (path: string, missingOk: boolean) =>
  readTable(path, "the run log", ["repo", "pr", "head", "outcome"], missingOk);

function readEarlierAudits(dir: string): Map<string, Record<string, string>> {
  const latest = new Map<string, Record<string, string>>();
  if (!existsSync(dir)) return latest;
  const runs = readdirSync(dir).flatMap((name) => {
    const match = /^(\d{4}-\d{2}-\d{2}-\d+)(?:-(\d+))?\.tsv$/.exec(name);
    return match === null ? [] : [{ name, stamp: match[1], n: Number(match[2] ?? 1) }];
  });
  runs.sort((a, b) => (a.stamp === b.stamp ? a.n - b.n : a.stamp < b.stamp ? -1 : 1));
  for (const { name } of runs)
    for (const row of readTable(
      join(dir, name),
      "the earlier audit",
      ["repo", "pr", "merged_at", "head", "receipt"],
      false
    ))
      latest.set(receiptKey(row.repo, row.pr, row.head), row);
  return latest;
}

function oldestUnresolvedGap(
  latest: ReadonlyMap<string, Record<string, string>>,
  repos: ReadonlySet<string>,
  historical: ReadonlyMap<string, string>
): { readonly date: string; readonly key: string } | null {
  let held: { date: string; key: string } | null = null;
  for (const [key, row] of latest) {
    const status: Status =
      row.receipt === "yes"
        ? "receipted"
        : historical.has(key)
          ? "historical"
          : "new";
    const date = row.merged_at.slice(0, 10);
    if (
      unresolved(status) &&
      repos.has(row.repo.toLowerCase()) &&
      (held === null || date < held.date)
    )
      held = { date, key };
  }
  return held;
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  return rows.map((row) =>
    row
      .map((cell, i) => cell.padEnd(widths[i]))
      .join("  ")
      .trimEnd()
  );
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

  const dir = join(runtime.store, "merge-gate", "audit");
  let since = options.since;
  let heldBy: string | null = null;
  let earlier = new Map<string, Record<string, string>>();
  const results: {
    readonly repo: string;
    readonly merges: readonly (MergedPull & {
      readonly key: string;
      readonly status: Status;
      readonly note: string;
    })[];
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
    const names = repos.map((repo) => `${repo.owner}/${repo.repo}`);
    earlier = readEarlierAudits(dir);
    const historical = new Map([
      ...[...earlier].flatMap(([key, row]): [string, string][] =>
        row.gap === "historical" ? [[key, row.note ?? ""]] : []
      ),
      ...options.historical,
    ]);
    const held = oldestUnresolvedGap(
      earlier,
      new Set(names.map((name) => name.toLowerCase())),
      historical
    );
    if (held !== null && held.date < since) {
      since = held.date;
      heldBy = held.key;
    }
    for (const [i, repo] of repos.entries()) {
      const name = names[i];
      const merges = await runtime.github.mergedPullRequests(repo, since);
      results.push({
        repo: name,
        merges: merges.map((pull) => {
          const key = receiptKey(name, String(pull.number), pull.head);
          const status: Status = receipts.has(key)
            ? "receipted"
            : historical.has(key)
              ? "historical"
              : options.known.has(key)
                ? "known"
                : "new";
          const note = status === "historical" ? (historical.get(key) ?? "") : "";
          return { ...pull, key, status, note };
        }),
      });
    }
  } catch (error) {
    runtime.stdout(
      `ERROR: the merge audit could not read everything it needs: ${message(error)}\n` +
        (heldBy === null
          ? ""
          : `The window starts ${since} for the unresolved gap ${heldBy}. To release it, settle the gap with --historical ${heldBy}=<reason>.\n`)
    );
    return EXIT.error;
  }

  const all = results.flatMap(({ repo, merges }) => merges.map((pull) => ({ repo, ...pull })));
  const audited = new Set(results.map(({ repo }) => repo.toLowerCase()));
  const seen = new Set(all.map((pull) => pull.key));
  // A gap settled outside the window still gets its row, so the next audit reads it as historical.
  const settled = [...options.historical].flatMap(([key, note]) => {
    const repo = key.slice(0, key.indexOf("#"));
    if (!audited.has(repo) || seen.has(key)) return [];
    const prior = earlier.get(key);
    return [
      {
        repo: prior?.repo ?? repo,
        number: Number(key.slice(key.indexOf("#") + 1, key.indexOf("@"))),
        head: key.slice(key.indexOf("@") + 1),
        mergedAt: prior?.merged_at ?? "",
        mergedBy: prior?.merged_by || null,
        key,
        status: "historical" as const,
        note,
      },
    ];
  });
  const reported = [...all, ...settled];
  const gaps = (status: Status) => reported.filter((pull) => pull.status === status);
  const rowOf = (pull: (typeof reported)[number]) => [
    pull.repo,
    `#${pull.number}`,
    pull.mergedAt,
    pull.mergedBy ?? "(unknown)",
    pull.head,
  ];
  const columns = ["repo", "PR", "merged at", "merged by", "head"];
  const out: string[] = [];
  if (options.unreachable.length > 0)
    out.push(
      `Unreachable, receipts not read: ${options.unreachable.join(", ")}. A merge gated there shows below as a gap.`
    );
  if (since !== options.since)
    out.push(
      `The window starts ${since}, not ${options.since}, to keep the gaps an earlier audit left unresolved.`
    );
  if (results.length === 0)
    out.push(
      "No repos to audit: this machine's runs.tsv names none. Pass --repo <owner/name>."
    );
  else if (reported.every((pull) => pull.status === "receipted"))
    out.push(`Every merge since ${since} has a gate receipt.`);
  else {
    const fresh = gaps("new");
    if (fresh.length === 0)
      out.push(`No new merge without a gate receipt since ${since}.`);
    else
      out.push(
        `New merges since ${since} with no gate receipt:`,
        ...table([columns, ...fresh.map(rowOf)])
      );
    const known = gaps("known");
    if (known.length > 0)
      out.push("Known gaps, still with no gate receipt:", ...table([columns, ...known.map(rowOf)]));
    const historical = gaps("historical");
    if (historical.length > 0)
      out.push(
        "Historical, no gate receipt:",
        ...table([
          [...columns, "reason"],
          ...historical.map((pull) => [...rowOf(pull), pull.note]),
        ])
      );
  }
  const unseen = [...options.known].filter(
    (key) => audited.has(key.slice(0, key.indexOf("#"))) && !seen.has(key)
  );
  if (unseen.length > 0)
    out.push(
      `Known gaps not among the merges since ${since} (a wrong PR or head, or an older merge):`,
      ...unseen.map((key) => `  ${key}`)
    );
  out.push("");
  for (const { repo, merges } of results) {
    const count = (status: Status) => merges.filter((pull) => pull.status === status).length;
    const receipted = count("receipted");
    const without = merges.length - receipted;
    out.push(
      `${repo}: ${merges.length} merge${merges.length === 1 ? "" : "s"}, ${receipted} receipt${receipted === 1 ? "" : "s"}, ${without} without` +
        (without === 0
          ? ""
          : ` (${count("new")} new, ${count("known")} known, ${count("historical")} historical)`)
    );
  }

  const stamp = runtime.now().toISOString();
  const name = `${stamp.slice(0, 10)}-${stamp.slice(11, 13)}${stamp.slice(14, 16)}${stamp.slice(17, 19)}`;
  let file = join(dir, `${name}.tsv`);
  const tsv = [
    "repo\tpr\tmerged_at\tmerged_by\thead\treceipt\tgap\tnote",
    ...reported.map((pull) =>
      [
        pull.repo,
        pull.number,
        pull.mergedAt,
        pull.mergedBy ?? "",
        pull.head,
        pull.status === "receipted" ? "yes" : "no",
        pull.status === "receipted" ? "" : pull.status,
        pull.note,
      ].join("\t")
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
  return all.some((pull) => unresolved(pull.status)) ? 1 : 0;
}
