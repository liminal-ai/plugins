import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from "commander";
import { WatcherQueryError } from "../watch-pr/github.ts";
import type { Repository } from "../watch-pr/types.ts";
import { parsePrNumber } from "../watch-pr/types.ts";
import {
  BOX_ID,
  type Facts,
  type PlanBoxes,
  type PrRef,
  type Waiver,
  evaluate,
  missingNames,
  renderEvaluations,
  short,
  strayWaivers,
} from "./gate.ts";
import { Git, ReadError } from "./git.ts";
import {
  GhGitHub,
  type GitHub,
  MERGE_BRIEF,
  MERGE_METHODS,
  type WriteAttempt,
  type MergeMethod,
  type MergeReadBack,
} from "./github.ts";
import { readPlanBoxes } from "./plan.ts";
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
  readonly method: MergeMethod;
  readonly plan: { readonly path: string; readonly pr: string } | null;
  readonly waivers: readonly Waiver[];
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
  readonly waived: readonly Waiver[];
}

const LOG_HEADER = "ts\trepo\tpr\thead\tmode\toutcome\tmissing\twaived\n";
const OLD_LOG_HEADER = "ts\trepo\tpr\thead\tmode\toutcome\tmissing\n";

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

function collectWaiver(value: string, previous: readonly Waiver[]): Waiver[] {
  const at = value.indexOf("=");
  const id = at === -1 ? value : value.slice(0, at);
  const reason = at === -1 ? "" : value.slice(at + 1).trim();
  if (!BOX_ID.test(id))
    throw new InvalidArgumentError(`"${id}" is not a box id such as perf or live-3`);
  if (reason === "")
    throw new InvalidArgumentError(`box ${id} needs a reason: --accept-skip ${id}=<reason>`);
  if (previous.some((waiver) => waiver.id === id))
    throw new InvalidArgumentError(`box ${id} is waived more than once`);
  return [...previous, { id, reason }];
}

function parseArgs(argv: readonly string[], runtime: Runtime): Options {
  const program = new Command("merge-gate")
    .description(
      "Merge a PR only when every merge requirement holds at its current head.\nFirst prints the repo's merge brief, .agents/merge-brief.md on its default branch.\nExit 0 merged (or would merge, with --check), 1 refused, 2 usage or read error."
    )
    .configureOutput({ writeOut: runtime.stdout, writeErr: runtime.stderr })
    .exitOverride()
    .requiredOption("--pr <n>", "pull request number", parsePr)
    .option(
      "--repo <owner/name>",
      "GitHub repo (default: the origin remote's repo); from a directory with no remote for it, the gate keeps its own clone under the pstack store",
      parseRepo
    )
    .option("--check", "evaluate and print, merge nothing", false)
    .addOption(
      new Option("--method <method>", "how GitHub merges the PR")
        .choices(MERGE_METHODS)
        .default("squash")
    )
    .option(
      "--plan <file>",
      "the PR's plan; the verdict must list every verify box of its section"
    )
    .option("--plan-pr <id>", "the PR id that ends the section's title, such as GC2")
    .option(
      "--accept-skip <id=reason>",
      "the lead accepts the verdict's skipped box <id>, for <reason>; repeatable, posted on the PR before the merge",
      collectWaiver,
      []
    );
  program.parse(argv, { from: "user" });
  const raw = program.opts<{
    pr: PrRef["number"];
    repo?: Repository;
    check: boolean;
    method: MergeMethod;
    plan?: string;
    planPr?: string;
    acceptSkip: Waiver[];
  }>();
  if ((raw.plan === undefined) !== (raw.planPr === undefined))
    program.error("error: --plan and --plan-pr go together");
  return {
    pr: raw.pr,
    repo: raw.repo ?? null,
    check: raw.check,
    method: raw.method,
    plan:
      raw.plan === undefined || raw.planPr === undefined
        ? null
        : { path: raw.plan, pr: raw.planPr },
    waivers: raw.acceptSkip,
  };
}

const cell = (value: string): string => value.replace(/[\t\r\n]+/g, " ");

function appendRun(runtime: Runtime, run: RunRecord): void {
  const dir = join(runtime.store, "merge-gate");
  const file = join(dir, "runs.tsv");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(file)) appendFileSync(file, LOG_HEADER);
  else {
    const text = readFileSync(file, "utf8");
    if (text.startsWith(OLD_LOG_HEADER))
      writeFileSync(file, LOG_HEADER + text.slice(OLD_LOG_HEADER.length));
  }
  const row = [
    runtime.now().toISOString(),
    run.repo,
    run.pr,
    run.head,
    run.mode,
    run.outcome,
    run.missing.join("; "),
    run.waived.map((waiver) => `${waiver.id}: ${waiver.reason}`).join("; "),
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
  const cwd = new Git(runtime.cwd);
  let git: Git;
  let label = `PR #${options.pr}`;
  let base: Omit<RunRecord, "outcome" | "missing"> = {
    repo: "",
    pr: String(options.pr),
    head: "",
    mode,
    waived: options.waivers,
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
  let plan: PlanBoxes | null = null;
  try {
    const repo = options.repo ?? cwd.originRepo();
    pr = { ...repo, number: options.pr };
    label = `${repo.owner}/${repo.repo}#${pr.number}`;
    base = { ...base, repo: `${repo.owner}/${repo.repo}` };
    runtime.stdout(await mergeBrief(runtime.github, repo));
    git = cwd.forRepo(runtime.store, repo);
    if (options.plan !== null)
      plan = readPlanBoxes(options.plan.path, options.plan.pr);
    facts = await readFacts(runtime.github, git, pr, plan, options.waivers);
  } catch (error) {
    return readFailed(error);
  }

  const head = facts.pull.headRefOid;
  const run = { ...base, head };
  const at = `${label} at ${short(head)}`;
  const stray = strayWaivers(facts.verdict, options.waivers);
  if (stray.length > 0)
    return {
      exit: EXIT.error,
      text: `ERROR: ${at}\nAn --accept-skip names a box the verdict did not skip, so nothing was merged. Waive only the boxes the verdict lists as skipped.\n${stray.map((line) => `  ${line}`).join("\n")}\n`,
      run: { ...run, outcome: "error", missing: stray.map((line) => `usage: ${line}`) },
    };
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

  // gh pr merge pins only the head, so every other requirement is read and judged again right before the merge.
  let fresh: Facts;
  try {
    fresh = await readFacts(runtime.github, git, pr, plan, options.waivers);
  } catch (error) {
    return readFailed(error, run);
  }
  if (fresh.pull.headRefOid !== head)
    return notMerged(
      `Since the gate checked the PR, the head moved from ${short(head)} to ${short(fresh.pull.headRefOid)}. Nothing was merged. Run the gate again.`
    );
  const lapsed = evaluate(fresh).filter((entry) => !entry.result.met);
  if (lapsed.length > 0)
    return {
      exit: EXIT.refused,
      text: renderEvaluations(
        `NOT MERGED: ${at}\nSince the gate checked the PR, ${lapsed.length === 1 ? "a requirement" : "requirements"} stopped holding. Nothing was merged.`,
        lapsed
      ),
      run: { ...run, outcome: "refused", missing: missingNames(lapsed) },
    };
  const freshStray = strayWaivers(fresh.verdict, options.waivers);
  if (freshStray.length > 0)
    return notMerged(
      `Since the gate checked the PR, the verdict changed and no longer skips every box the run waives (${freshStray.join("; ")}). Nothing was merged. Run the gate again.`
    );
  if (options.waivers.length > 0 && fresh.verdict.kind === "found") {
    const posted = await runtime.github
      .comment(pr, waiverComment(fresh.verdict.url, head, options.waivers))
      .catch((error: unknown): WriteAttempt => ({
        ok: false,
        detail: message(error),
      }));
    if (!posted.ok)
      return notMerged(
        `The lead's waivers could not be posted on the PR (${posted.detail}), and a waiver counts only when the PR records it. Nothing was merged.`
      );
  }

  const attempt = await runtime.github
    .merge(pr, head, options.method)
    .catch((error: unknown): WriteAttempt => ({
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

/** The repo's own merge rules, printed before any verdict; a failed read is reported and never blocks. */
async function mergeBrief(github: GitHub, repo: Repository): Promise<string> {
  const name = `${repo.owner}/${repo.repo}`;
  try {
    const text = await github.mergeBrief(repo);
    if (text === null)
      return `${name} has no merge brief (${MERGE_BRIEF} on its default branch). /create-verification-skill writes one.\n\n`;
    return `Merge brief for ${name}:\n${text.trimEnd()}\n\n`;
  } catch (error) {
    return `The merge brief for ${name} (${MERGE_BRIEF}) could not be read: ${message(error)}\n\n`;
  }
}

function waiverComment(
  verdictUrl: string,
  head: string,
  waivers: readonly Waiver[]
): string {
  return [
    `merge-gate: the lead waived these skipped boxes of the verdict ${verdictUrl} to merge ${head}.`,
    "",
    ...waivers.map((waiver) => `- ${waiver.id}: ${waiver.reason}`),
  ].join("\n");
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
    waived: [],
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
