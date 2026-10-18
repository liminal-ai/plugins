import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { WatcherQueryError } from "../watch-pr/github.ts";
import type { Repository } from "../watch-pr/types.ts";
import { parsePrNumber } from "../watch-pr/types.ts";
import {
  type Facts,
  type PrRef,
  type PullRequest,
  evaluate,
  missingNames,
  renderEvaluations,
  short,
} from "./gate.ts";
import { Git, ReadError } from "./git.ts";
import {
  GhGitHub,
  type GitHub,
  type MergeAttempt,
  type MergeReadBack,
} from "./github.ts";
import { readFacts } from "./read.ts";

export const EXIT = { merged: 0, refused: 1, error: 2 } as const;

export interface Runtime {
  readonly github: GitHub;
  readonly cwd: string;
  readonly store: string;
  readonly now: () => Date;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface Options {
  readonly pr: PrRef["number"];
  readonly repo: Repository | null;
  readonly check: boolean;
}

interface RunRecord {
  readonly repo: string;
  readonly pr: string;
  readonly head: string;
  readonly mode: "check" | "merge";
  readonly outcome:
    | "merged"
    | "would-merge"
    | "refused"
    | "wrong-base"
    | "merged-elsewhere"
    | "error";
  readonly missing: readonly string[];
}

const LOG_HEADER = "ts\trepo\tpr\thead\tmode\toutcome\tmissing\n";

function parseRepo(value: string): Repository {
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(value);
  if (match === null) throw new InvalidArgumentError("must be <owner>/<name>");
  return { owner: match[1], repo: match[2] };
}

function parsePr(value: string): PrRef["number"] {
  try {
    return parsePrNumber(Number(value.replace(/^#/, "")));
  } catch {
    throw new InvalidArgumentError("must be a positive integer");
  }
}

function parseArgs(argv: readonly string[], runtime: Runtime): Options {
  const program = new Command("merge-gate")
    .description(
      "Merge a PR only when every merge requirement holds at its current head.\nExit 0 merged (or would merge, with --check), 1 refused, 2 usage or read error."
    )
    .configureOutput({ writeOut: runtime.stdout, writeErr: runtime.stderr })
    .exitOverride()
    .requiredOption("--pr <n>", "pull request number", parsePr)
    .option(
      "--repo <owner/name>",
      "GitHub repo (default: the origin remote's repo)",
      parseRepo
    )
    .option("--check", "evaluate and print, merge nothing", false);
  program.parse(argv, { from: "user" });
  const raw = program.opts<{
    pr: PrRef["number"];
    repo?: Repository;
    check: boolean;
  }>();
  return { pr: raw.pr, repo: raw.repo ?? null, check: raw.check };
}

const cell = (value: string): string => value.replace(/[\t\r\n]+/g, " ");

function appendRun(runtime: Runtime, run: RunRecord): void {
  const dir = join(runtime.store, "merge-gate");
  const file = join(dir, "runs.tsv");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(file)) appendFileSync(file, LOG_HEADER);
  const row = [
    runtime.now().toISOString(),
    run.repo,
    run.pr,
    run.head,
    run.mode,
    run.outcome,
    run.missing.join("; "),
  ];
  appendFileSync(file, `${row.map(cell).join("\t")}\n`);
}

interface Decision {
  readonly exit: number;
  readonly text: string;
  readonly run: RunRecord;
}

const message = (error: unknown): string =>
  error instanceof ReadError || error instanceof WatcherQueryError
    ? error.message
    : `unexpected error: ${error instanceof Error ? error.message : String(error)}`;

async function decide(options: Options, runtime: Runtime): Promise<Decision> {
  const mode = options.check ? "check" : "merge";
  const git = new Git(runtime.cwd);
  let label = `PR #${options.pr}`;
  let base: Omit<RunRecord, "outcome" | "missing"> = {
    repo: "",
    pr: String(options.pr),
    head: "",
    mode,
  };
  const readFailed = (error: unknown, run = base): Decision => {
    const detail = message(error);
    return {
      exit: EXIT.error,
      text: `ERROR: ${label}\nCould not read everything the gate needs, so nothing was merged: ${detail}\n`,
      run: { ...run, outcome: "error", missing: [`read error: ${detail}`] },
    };
  };
  let pr: PrRef;
  let facts: Facts;
  try {
    const repo = options.repo ?? git.originRepo();
    pr = { ...repo, number: options.pr };
    label = `${repo.owner}/${repo.repo}#${pr.number}`;
    base = { ...base, repo: `${repo.owner}/${repo.repo}` };
    facts = await readFacts(runtime.github, git, pr);
  } catch (error) {
    return readFailed(error);
  }

  const head = facts.pull.headRefOid;
  const run = { ...base, head };
  const at = `${label} at ${short(head)}`;
  const evaluations = evaluate(facts);
  const missing = missingNames(evaluations);
  if (missing.length > 0)
    return {
      exit: EXIT.refused,
      text: renderEvaluations(`REFUSED: ${at}`, evaluations),
      run: { ...run, outcome: "refused", missing },
    };
  if (options.check)
    return {
      exit: EXIT.merged,
      text: renderEvaluations(`WOULD MERGE: ${at}`, evaluations),
      run: { ...run, outcome: "would-merge", missing: [] },
    };

  const notMerged = (why: string): Decision => ({
    exit: EXIT.refused,
    text: `NOT MERGED: ${at}\n${why}\n`,
    run: { ...run, outcome: "refused", missing: [`merge: ${why}`] },
  });

  // gh pr merge can pin the head but not the base, so a retarget after this read still merges.
  let current: PullRequest;
  try {
    current = await runtime.github.pullRequest(pr);
  } catch (error) {
    return readFailed(error, run);
  }
  const moved: string[] = [];
  if (current.headRefOid !== head)
    moved.push(
      `the head moved from ${short(head)} to ${short(current.headRefOid)}`
    );
  if (current.baseRefName !== facts.pull.baseRefName)
    moved.push(
      `the base changed from ${facts.pull.baseRefName} to ${current.baseRefName}`
    );
  if (moved.length > 0)
    return notMerged(
      `Since the gate checked the PR, ${moved.join(" and ")}. Nothing was merged. Run the gate again.`
    );

  const attempt = await runtime.github
    .merge(pr, head)
    .catch((error: unknown): MergeAttempt => ({
      ok: false,
      detail: message(error),
    }));
  let after: MergeReadBack;
  try {
    after = await runtime.github.readBack(pr);
  } catch (error) {
    return notMerged(
      `${attempt.ok ? "The merge command succeeded" : `The merge command failed (${attempt.detail})`}, but the PR could not be read back: ${message(error)}. Check the PR by hand.`
    );
  }
  const commit =
    after.mergeCommit === null ? "" : ` as ${short(after.mergeCommit)}`;
  if (after.state === "MERGED" && after.baseRefName !== facts.defaultBranch)
    return {
      exit: EXIT.refused,
      text: `MERGED INTO THE WRONG BASE: ${at} into ${after.baseRefName}, not ${facts.defaultBranch}\nThe merge happened. GitHub reads the PR as merged into ${after.baseRefName}${after.mergedAt === null ? "" : ` at ${after.mergedAt}`}${commit}, so its change is not on ${facts.defaultBranch}. Merge nothing else from this stack. Tell Lee.\n`,
      run: {
        ...run,
        outcome: "wrong-base",
        missing: [`merged into ${after.baseRefName}`],
      },
    };
  if (attempt.ok && after.state === "MERGED")
    return {
      exit: EXIT.merged,
      text: renderEvaluations(
        `MERGED: ${at} into ${after.baseRefName}${commit}`,
        evaluations
      ),
      run: { ...run, outcome: "merged", missing: [] },
    };
  if (!attempt.ok && after.state === "MERGED")
    return {
      exit: EXIT.refused,
      text: `MERGED, BUT NOT BY THE GATE: ${at} into ${after.baseRefName}${commit}\nThe gate's merge command failed (${attempt.detail}), yet GitHub reads the PR as merged${after.mergedAt === null ? "" : ` at ${after.mergedAt}`}. Someone else merged it, and the gate cannot say which head landed. Check the merge commit before building on it.\n`,
      run: {
        ...run,
        outcome: "merged-elsewhere",
        missing: [`merge: ${attempt.detail}`],
      },
    };
  const read = `GitHub reads the PR as ${after.state} against ${after.baseRefName}${after.mergedAt === null ? "" : `, merged at ${after.mergedAt}`}.`;
  return notMerged(
    attempt.ok
      ? `The merge command succeeded but the PR is not merged into ${facts.defaultBranch}. It may be queued or set to auto-merge. ${read}`
      : `The merge command failed: ${attempt.detail}. ${read}`
  );
}

/** What a run that never parsed still tells the log: the raw --repo and --pr, if given. */
function usageRun(argv: readonly string[], error: CommanderError): RunRecord {
  const raw = (flag: string): string => {
    const index = argv.indexOf(flag);
    const value =
      index >= 0
        ? argv[index + 1]
        : argv
            .find((arg) => arg.startsWith(`${flag}=`))
            ?.slice(flag.length + 1);
    return value === undefined || value.startsWith("--") ? "" : value;
  };
  return {
    repo: raw("--repo"),
    pr: raw("--pr"),
    head: "",
    mode: argv.includes("--check") ? "check" : "merge",
    outcome: "error",
    missing: [`usage: ${error.message.replace(/^error: /, "")}`],
  };
}

function log(runtime: Runtime, run: RunRecord): void {
  try {
    appendRun(runtime, run);
  } catch (error) {
    runtime.stderr(
      `could not write the run log: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}

export async function main(
  argv: readonly string[],
  runtime: Runtime = realRuntime()
): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(argv, runtime);
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    if (error.exitCode === 0) return 0;
    log(runtime, usageRun(argv, error));
    return EXIT.error;
  }
  const decision = await decide(options, runtime);
  runtime.stdout(decision.text);
  log(runtime, decision.run);
  return decision.exit;
}

function realRuntime(): Runtime {
  return {
    github: new GhGitHub(),
    cwd: process.cwd(),
    store:
      process.env.PSTACK_STORE || join(homedir(), ".local", "state", "pstack"),
    now: () => new Date(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}
