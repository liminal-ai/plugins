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
import { audit } from "./audit.ts";
import type { Repository } from "../watch-pr/types.ts";
import { parsePrNumber } from "../watch-pr/types.ts";
import {
  type Acceptances,
  type Accepted,
  BOX_FORMS,
  BOX_ID,
  type CheckWaiver,
  type Deferral,
  type Facts,
  type PlanRef,
  type PrRef,
  SHORTCUT_FORM,
  SHORTCUT_ID,
  evaluate,
  isDeferOwner,
  missingNames,
  renderEvaluations,
  short,
  strayAcceptances,
  WAIVABLE_CHECKS,
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
  readonly plan: PlanRef | null;
  readonly accepted: Acceptances;
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
  readonly accepted: readonly AcceptedEntry[];
}

const LOG_HEADER = "ts\trepo\tpr\thead\tmode\toutcome\tmissing\twaived\n";
const OLD_LOG_HEADER = "ts\trepo\tpr\thead\tmode\toutcome\tmissing\n";

export function parseRepo(value: string): Repository {
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

function idValue(
  value: string,
  previous: readonly { readonly id: string }[],
  what: string,
  idForm: RegExp,
  usage: string
): { readonly id: string; readonly value: string } {
  const at = value.indexOf("=");
  const id = at === -1 ? value : value.slice(0, at);
  const rest = at === -1 ? "" : value.slice(at + 1).trim();
  if (!idForm.test(id))
    throw new InvalidArgumentError(`"${id}" is not a ${what} id such as perf or live-3`);
  if (rest === "")
    throw new InvalidArgumentError(`${what} ${id} needs ${usage.replace("<id>", id)}`);
  if (previous.some((entry) => entry.id === id))
    throw new InvalidArgumentError(`${what} ${id} is given more than once`);
  return { id, value: rest };
}

function collectSkip(value: string, previous: readonly Accepted[]): Accepted[] {
  const { id, value: reason } = idValue(
    value,
    previous,
    "box",
    BOX_ID,
    "a reason: --accept-skip <id>=<reason>"
  );
  return [...previous, { id, reason }];
}

function collectShortcut(value: string, previous: readonly Accepted[]): Accepted[] {
  const { id, value: reason } = idValue(
    value,
    previous,
    "shortcut",
    SHORTCUT_ID,
    "a reason: --accept-shortcut <id>=<reason>"
  );
  return [...previous, { id, reason }];
}

function collectDeferral(value: string, previous: readonly Deferral[]): Deferral[] {
  const { id, value: owner } = idValue(
    value,
    previous,
    "box",
    BOX_ID,
    "an owner: --defer <id>=<owner>"
  );
  if (!isDeferOwner(owner))
    throw new InvalidArgumentError(
      `box ${id}'s owner "${owner}" is neither a Linear id such as LH-215 nor an open workflow step as <thread id>/w<n>.<n>. Owed work needs an owner that will pick it up`
    );
  return [...previous, { id, owner }];
}

function collectCheckWaiver(
  value: string,
  previous: readonly CheckWaiver[]
): CheckWaiver[] {
  const at = value.indexOf("=");
  const check = at === -1 ? value : value.slice(0, at);
  const reason = at === -1 ? "" : value.slice(at + 1).trim();
  if (!WAIVABLE_CHECKS.includes(check))
    throw new InvalidArgumentError(
      `"${check}" is not a check the lead may waive. Waivable: ${WAIVABLE_CHECKS.join(", ")}. The verdict, plan boxes, open and mergeable, auto-merge, review decision and instruction-file approval are never waived`
    );
  if (reason === "")
    throw new InvalidArgumentError(`check ${check} needs a reason: --waive ${check}=<reason>`);
  if (previous.some((waiver) => waiver.check === check))
    throw new InvalidArgumentError(`check ${check} is waived more than once`);
  return [...previous, { check, reason }];
}

export interface AcceptedEntry {
  readonly kind: "skip" | "defer" | "shortcut" | "waiver";
  readonly id: string;
  /** The lead's reason, or a deferral's owner. */
  readonly reason: string;
}

const acceptedEntries = ({ skips, deferrals, shortcuts, checks }: Acceptances): AcceptedEntry[] => [
  ...skips.map(({ id, reason }) => ({ kind: "skip" as const, id, reason })),
  ...deferrals.map(({ id, owner }) => ({ kind: "defer" as const, id, reason: owner })),
  ...shortcuts.map(({ id, reason }) => ({ kind: "shortcut" as const, id, reason })),
  ...checks.map(({ check, reason }) => ({ kind: "waiver" as const, id: check, reason })),
];

/**
 * A run log's waived cell as entries. Rows before the JSON form joined `<box>: <reason>` and
 * `check <check>: <reason>` with "; ", which a reason can hold too, so those split only where an entry starts.
 */
export function readWaivedCell(cell: string): readonly AcceptedEntry[] {
  if (cell.trim() === "") return [];
  if (cell.startsWith("[")) return JSON.parse(cell) as AcceptedEntry[];
  return cell.split(/; (?=(?:check [a-z]+|[a-z]+(?:-\d+)?): )/).map((entry) => {
    const match = /^(check )?([^:\s]+): ([\s\S]*)$/.exec(entry);
    if (match === null) return { kind: "skip", id: "", reason: entry };
    return { kind: match[1] === undefined ? "skip" : "waiver", id: match[2], reason: match[3] };
  });
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
      "the PR's plan; the verdict must list every verify box of its section. Without it, the gate uses the plan the PR body declares on a line \"pstack-plan: <file> pr=<id>\""
    )
    .option("--plan-pr <id>", "the PR id that ends the section's title, such as GC2")
    .option(
      "--accept-skip <id=reason>",
      "the lead accepts the verdict's skipped box <id> as not applying, for <reason>; repeatable, posted on the PR before the merge",
      collectSkip,
      []
    )
    .option(
      "--defer <id=owner>",
      "the lead defers the verdict's skipped box <id>, whose work is owed, to <owner>: a Linear id such as LH-215 or an open workflow step <thread id>/w<n>.<n>; repeatable, posted on the PR before the merge",
      collectDeferral,
      []
    )
    .option(
      "--accept-shortcut <id=reason>",
      "the lead accepts the shortcut <id> the verdict lists, for <reason>; repeatable, posted on the PR before the merge",
      collectShortcut,
      []
    )
    .option(
      "--waive <check=reason>",
      `the lead merges without the missing gate check <check> (${WAIVABLE_CHECKS.join(", ")}), for <reason>; repeatable, posted on the PR before the merge`,
      collectCheckWaiver,
      []
    );
  program.addHelpText(
    "after",
    `
Run "merge-gate audit --help" for the audit of merges against gate receipts.

The verdict lists each plan box under its pstack-verdict line as ${BOX_FORMS}.
A changed box counts only when it names who accepted the changed bar and why, separated by the first comma.
A re-verification that did not rerun something lists each shortcut as ${SHORTCUT_FORM}.
`
  );
  program.parse(argv, { from: "user" });
  const raw = program.opts<{
    pr: PrRef["number"];
    repo?: Repository;
    check: boolean;
    method: MergeMethod;
    plan?: string;
    planPr?: string;
    acceptSkip: Accepted[];
    defer: Deferral[];
    acceptShortcut: Accepted[];
    waive: CheckWaiver[];
  }>();
  if ((raw.plan === undefined) !== (raw.planPr === undefined))
    program.error("error: --plan and --plan-pr go together");
  const both = raw.acceptSkip.find(({ id }) => raw.defer.some((d) => d.id === id));
  if (both !== undefined)
    program.error(
      `error: box ${both.id} is both accepted and deferred. Accept a box that does not apply; defer one whose work is owed`
    );
  return {
    pr: raw.pr,
    repo: raw.repo ?? null,
    check: raw.check,
    method: raw.method,
    plan:
      raw.plan === undefined || raw.planPr === undefined
        ? null
        : { path: raw.plan, pr: raw.planPr },
    accepted: {
      skips: raw.acceptSkip,
      deferrals: raw.defer,
      shortcuts: raw.acceptShortcut,
      checks: raw.waive,
    },
  };
}

const cell = (value: string): string => value.replace(/[\t\r\n]+/g, " ");

export const runLog = (store: string): string =>
  join(store, "merge-gate", "runs.tsv");

function appendRun(runtime: Runtime, run: RunRecord): void {
  const dir = join(runtime.store, "merge-gate");
  const file = runLog(runtime.store);
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
    run.accepted.length === 0 ? "" : JSON.stringify(run.accepted),
  ];
  appendFileSync(file, `${row.map(cell).join("\t")}\n`);
}

interface Decision {
  readonly exit: number;
  readonly text: string;
  readonly run: RunRecord;
}

export const message = (error: unknown): string =>
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
    accepted: acceptedEntries(options.accepted),
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
  const asked = {
    plan: options.plan,
    cwd: runtime.cwd,
    accepted: options.accepted,
  };
  try {
    const repo = options.repo ?? cwd.originRepo();
    pr = { ...repo, number: options.pr };
    label = `${repo.owner}/${repo.repo}#${pr.number}`;
    base = { ...base, repo: `${repo.owner}/${repo.repo}` };
    runtime.stdout(await mergeBrief(runtime.github, repo));
    git = cwd.forRepo(runtime.store, repo);
    facts = await readFacts(runtime.github, git, pr, asked);
  } catch (error) {
    return readFailed(error);
  }

  const head = facts.pull.headRefOid;
  const run = { ...base, head };
  const at = `${label} at ${short(head)}`;
  const stray = strayAcceptances(facts);
  if (stray.length > 0)
    return {
      exit: EXIT.error,
      text: `ERROR: ${at}\nAn acceptance names a box the verdict did not skip, a shortcut it does not list, or a check that holds, so nothing was merged. Accept or defer only the boxes the verdict lists as skipped, accept only the shortcuts it lists, and waive only the checks the gate finds missing.\n${stray.map((line) => `  ${line}`).join("\n")}\n`,
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
    fresh = await readFacts(runtime.github, git, pr, asked);
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
  const freshStray = strayAcceptances(fresh);
  if (freshStray.length > 0)
    return notMerged(
      `Since the gate checked the PR, something the run waives came to hold (${freshStray.join("; ")}). Nothing was merged. Run the gate again.`
    );
  if (
    Object.values(options.accepted).some((given) => given.length > 0) &&
    fresh.verdict.kind === "found"
  ) {
    const posted = await runtime.github
      .comment(pr, acceptanceComment(fresh.verdict, head, options.accepted))
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

function acceptanceComment(
  verdict: Extract<Facts["verdict"], { kind: "found" }>,
  head: string,
  { skips, deferrals, shortcuts, checks }: Acceptances
): string {
  const sections: string[][] = [];
  const section = (title: string, lines: readonly string[]): void => {
    if (lines.length > 0) sections.push([title, "", ...lines]);
  };
  section(
    `merge-gate: the lead waived these skipped boxes of the verdict ${verdict.url} to merge ${head}.`,
    skips.map(({ id, reason }) => `- ${id}: ${reason}`)
  );
  section(
    `merge-gate: the lead deferred these skipped boxes of the verdict ${verdict.url} to their owners to merge ${head}.`,
    deferrals.map(({ id, owner }) => {
      const note = verdict.boxes.find((box) => box.id === id)?.note ?? "";
      return `- ${id}: ${owner}${note === "" ? "" : `. Owed: ${note}`}`;
    })
  );
  section(
    `merge-gate: the lead accepted these shortcuts the verdict ${verdict.url} lists to merge ${head}.`,
    shortcuts.map(({ id, reason }) => `- ${id}: ${reason}`)
  );
  section(
    `merge-gate: the lead waived these missing gate checks to merge ${head}.`,
    checks.map(({ check, reason }) => `- ${check}: ${reason}`)
  );
  return sections.map((lines) => lines.join("\n")).join("\n\n");
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
    accepted: [],
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
  if (argv[0] === "audit") return audit(argv.slice(1), runtime);
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
