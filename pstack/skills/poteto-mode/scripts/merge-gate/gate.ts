import type {
  Check,
  PrNumber,
  Repository,
  ReviewDecision,
} from "../watch-pr/types.ts";

export interface PrRef extends Repository {
  readonly number: PrNumber;
}

export interface PullRequest {
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly isDraft: boolean;
  readonly mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  readonly baseRefName: string;
  readonly headRefOid: string;
  readonly reviewDecision: ReviewDecision;
  readonly autoMergeArmed: boolean;
}

/** `app` is the slug of the GitHub App whose check suite reported a check run; null for a commit status or an app GitHub does not name. */
export type HeadCheck = Check & { readonly app: string | null };

export interface OpenThread {
  readonly author: string | null;
  readonly path: string | null;
  readonly line: number | null;
  readonly body: string;
  readonly url: string | null;
}

export const AUTHOR_ASSOCIATIONS = [
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "MANNEQUIN",
  "NONE",
] as const;
export type AuthorAssociation = (typeof AUTHOR_ASSOCIATIONS)[number];

export interface IssueComment {
  /** GitHub's REST id. It grows with creation order, so it orders comments posted in the same second. */
  readonly id: number;
  readonly author: string;
  readonly isBot: boolean;
  readonly association: AuthorAssociation;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url: string;
}

export type HashResult =
  | { readonly ok: true; readonly hash: string }
  | { readonly ok: false; readonly detail: string };

export type VerdictOutcome = "PASS" | "PASS+NOTES" | "FAIL";

export interface IgnoredVerdict {
  readonly author: string;
  readonly association: AuthorAssociation;
  readonly url: string;
}

export type VerdictFact =
  | { readonly kind: "none"; readonly ignored: readonly IgnoredVerdict[] }
  | { readonly kind: "malformed"; readonly line: string; readonly url: string }
  | {
      readonly kind: "found";
      readonly outcome: VerdictOutcome;
      readonly head: string;
      readonly base: string;
      readonly by: string;
      readonly url: string;
      readonly recordedHash: HashResult;
    };

export interface InstructionFiles {
  readonly paths: readonly string[];
  readonly approvalHash: string;
}

/** Everything the requirements judge, read once at the PR's current head. */
export interface Facts {
  readonly pr: PrRef;
  readonly defaultBranch: string;
  readonly baseUsesMergeQueue: boolean;
  readonly pull: PullRequest;
  readonly checks: readonly HeadCheck[];
  readonly threads: readonly OpenThread[];
  readonly comments: readonly IssueComment[];
  readonly mergeBase: string;
  readonly currentHash: HashResult;
  readonly verdict: VerdictFact;
  readonly instructionFiles: InstructionFiles | null;
}

export type Result =
  | { readonly met: true; readonly note: string }
  | {
      readonly met: false;
      readonly missing: string;
      readonly details?: readonly string[];
    };

export interface Requirement {
  readonly name: string;
  readonly evaluate: (facts: Facts) => Result;
}

export interface Evaluation {
  readonly name: string;
  readonly result: Result;
}

const VERDICT_PREFIX = "pstack-verdict:";
const VERDICT_LINE =
  /^pstack-verdict: (PASS\+NOTES|PASS|FAIL) head=([0-9a-f]{40}) base=([0-9a-f]{40}) by=(\S+)$/;
const APPROVAL_PREFIX = "lee-approves-instruction-files:";
const APPROVED_IN = /^approved-in: \S+$/;
const CODEX_LOGINS = new Set([
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
]);
const CODEX_STATE = /<!-- codex-review-state:v1 (\{.*?\}) -->/s;

export const short = (sha: string): string => sha.slice(0, 7);

const lines = (body: string): string[] =>
  body.split(/\r?\n/).map((line) => line.trim());

const readable = (line: string): string =>
  line
    .replace(/\[?!\[[^\]]*\]\([^)]*\)(\]\([^)]*\))?/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();

const firstLine = (body: string): string =>
  lines(body)
    .map(readable)
    .find((line) => line !== "")
    ?.slice(0, 120) ?? "(empty comment)";

/** Anyone can comment on a public repo, so a pasted verdict or approval line counts only from someone with a role in it. */
const SPEAKS_FOR_REPO: ReadonlySet<AuthorAssociation> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);
export const speaksForRepo = (comment: IssueComment): boolean =>
  SPEAKS_FOR_REPO.has(comment.association);

export const hasVerdictLine = (comment: IssueComment): boolean =>
  lines(comment.body).some((line) => line.startsWith(VERDICT_PREFIX));

const isBugbot = (check: HeadCheck): boolean =>
  check.app === "cursor" && check.name.includes("Bugbot");

/** Creation order, not edit time, so editing an old comment never makes it the newest. */
const newestFirst = (a: IssueComment, b: IssueComment): number => b.id - a.id;

/** The most recent comment with a verdict line decides; its last such line counts. */
export function findVerdictLine(
  comments: readonly IssueComment[]
): { readonly line: string; readonly url: string } | null {
  for (const comment of [...comments].sort(newestFirst)) {
    const found = lines(comment.body).filter((line) =>
      line.startsWith(VERDICT_PREFIX)
    );
    const last = found[found.length - 1];
    if (last !== undefined) return { line: last, url: comment.url };
  }
  return null;
}

export function parseVerdictLine(line: string): {
  readonly outcome: VerdictOutcome;
  readonly head: string;
  readonly base: string;
  readonly by: string;
} | null {
  const match = VERDICT_LINE.exec(line.replace(/\s+/g, " "));
  if (match === null) return null;
  return {
    outcome: match[1] as VerdictOutcome,
    head: match[2],
    base: match[3],
    by: match[4],
  };
}

export const isInstructionFile = (path: string): boolean => {
  const name = path.split("/").pop()?.toLowerCase();
  return name === "agents.md" || name === "claude.md";
};

const met = (note: string): Result => ({ met: true, note });
const unmet = (missing: string, details?: readonly string[]): Result => ({
  met: false,
  missing,
  ...(details === undefined ? {} : { details }),
});

const openAndMergeable: Requirement = {
  name: "Open and mergeable",
  evaluate({ pull, defaultBranch, baseUsesMergeQueue }) {
    if (pull.state === "MERGED")
      return unmet("The PR is already merged. There is nothing to merge.");
    if (pull.state === "CLOSED")
      return unmet("The PR is closed. Reopen it before merging.");
    if (pull.isDraft)
      return unmet("The PR is a draft. Mark it ready for review.");
    if (pull.baseRefName !== defaultBranch)
      return unmet(
        `The PR targets ${pull.baseRefName}, not ${defaultBranch}. Merge its parent first, then retarget it to ${defaultBranch}.`
      );
    if (baseUsesMergeQueue)
      return unmet(
        `${defaultBranch} uses a merge queue. The gate merges directly, and here gh would only queue the PR, which could then land after the gate's checks went stale. Ask Lee how to land it.`
      );
    if (pull.mergeable === "CONFLICTING")
      return unmet(
        `The PR conflicts with ${defaultBranch}. Rebase it and push.`
      );
    if (pull.mergeable === "UNKNOWN")
      return unmet(
        "GitHub has not finished working out whether the PR merges cleanly. Run the gate again in a minute."
      );
    return met(`open, ready, targets ${defaultBranch}, no conflicts`);
  },
};

const autoMerge: Requirement = {
  name: "Auto-merge",
  evaluate({ pr, pull }) {
    if (!pull.autoMergeArmed) return met("not armed");
    return unmet(
      "Auto-merge is armed on the PR, so GitHub could land it later without the gate. Disarm it, then run the gate again:",
      [`gh pr merge ${pr.number} --repo ${pr.owner}/${pr.repo} --disable-auto`]
    );
  },
};

const checks: Requirement = {
  name: "Checks",
  evaluate({ checks: all }) {
    const counted = all.filter((check) => !isBugbot(check));
    const ignored = all.length - counted.length;
    const bugbot = ignored === 0 ? "" : `, ${ignored} Bugbot ignored`;
    if (counted.length === 0) return met(`no checks reported${bugbot}`);
    const running = counted.filter(
      (check) => check.kind === "pending" || check.kind === "code-review-gate"
    );
    const failed = counted.filter((check) => check.kind === "failed");
    if (running.length === 0 && failed.length === 0)
      return met(`${counted.length} passed${bugbot}`);
    const parts: string[] = [];
    if (failed.length > 0)
      parts.push(
        `${failed.length} failed (${failed.map((check) => check.name).join(", ")}). Fix the failures and push`
      );
    if (running.length > 0)
      parts.push(
        `${running.length} still running (${running.map((check) => check.name).join(", ")}). Wait for them to finish, then run the gate again`
      );
    return unmet(`${parts.join(". ")}.`);
  },
};

const reviewThreads: Requirement = {
  name: "Review threads",
  evaluate({ threads }) {
    if (threads.length === 0) return met("none open");
    return unmet(
      `${threads.length} unresolved. Address each one and resolve it.`,
      threads.map((thread) => {
        const where =
          thread.path === null
            ? "(no file)"
            : thread.line === null
              ? thread.path
              : `${thread.path}:${thread.line}`;
        return `${thread.author ?? "(unknown)"} at ${where}: ${firstLine(thread.body)} ${thread.url ?? ""}`.trimEnd();
      })
    );
  },
};

const reviewDecision: Requirement = {
  name: "Review decision",
  evaluate({ pull }) {
    if (pull.reviewDecision === "CHANGES_REQUESTED")
      return unmet(
        "A reviewer requested changes. Address them and have the reviewer approve or dismiss their review."
      );
    return met(
      pull.reviewDecision === null
        ? "no review decision"
        : pull.reviewDecision.toLowerCase().replace("_", " ")
    );
  },
};

const verdict: Requirement = {
  name: "Independent verdict",
  evaluate({ verdict: fact, currentHash, mergeBase, pull }) {
    const postLine = `pstack-verdict: <PASS|PASS+NOTES|FAIL> head=${pull.headRefOid} base=${mergeBase} by=<model>`;
    if (fact.kind === "none")
      return unmet(
        `No verdict on the PR. Have a verifier from the other model family review it and post the line "${postLine}".${fact.ignored.length === 0 ? "" : " The gate ignored the verdict lines below because their authors are not owners, members or collaborators of the repo."}`,
        fact.ignored.length === 0
          ? undefined
          : fact.ignored.map(
              (line) =>
                `ignored: ${line.author} (${line.association}) ${line.url}`
            )
      );
    if (fact.kind === "malformed")
      return unmet(
        `The latest verdict line does not read as "${postLine}" (${fact.url}). Have the verifier post a corrected line.`
      );
    if (fact.outcome === "FAIL")
      return unmet(
        `The latest verdict is FAIL (${fact.url}). Fix what it found and get a new verdict.`
      );
    const reason = !fact.recordedHash.ok
      ? `the verdict's change could not be hashed (${fact.recordedHash.detail})`
      : !currentHash.ok
        ? `the PR's current change could not be hashed (${currentHash.detail})`
        : fact.recordedHash.hash !== currentHash.hash
          ? "the code changed since the verdict"
          : null;
    if (reason !== null)
      return unmet(
        `The latest verdict covers ${short(fact.base)}..${short(fact.head)}, not the PR's current change ${short(mergeBase)}..${short(pull.headRefOid)}, because ${reason}. Get a new verdict at this head.`
      );
    return met(`${fact.outcome} by ${fact.by} covers this code`);
  },
};

const codexReview: Requirement = {
  name: "Codex review",
  evaluate({ comments, pull }) {
    const ask =
      'Comment "@codex review" on the PR and wait for Codex\'s summary comment to name this head.';
    for (const comment of [...comments].sort(newestFirst)) {
      if (!CODEX_LOGINS.has(comment.author)) continue;
      const match = CODEX_STATE.exec(comment.body);
      if (match === null) continue;
      let review: { commit_sha?: unknown; status?: unknown } | undefined;
      try {
        review = (JSON.parse(match[1]) as { code_review?: typeof review })
          .code_review;
      } catch {
        return unmet(
          `Codex's review state could not be read (${comment.url}). ${ask}`
        );
      }
      if (review?.commit_sha !== pull.headRefOid) {
        const seen =
          typeof review?.commit_sha === "string"
            ? short(review.commit_sha)
            : "no commit";
        return unmet(
          `Codex last reviewed ${seen}, not ${short(pull.headRefOid)}. ${ask}`
        );
      }
      if (review.status !== "completed")
        return unmet(
          `Codex's review of ${short(pull.headRefOid)} is ${String(review.status ?? "not started")}, not completed. Wait for it to finish.`
        );
      return met(`completed at ${short(pull.headRefOid)}`);
    }
    return unmet(`Codex has not reviewed the PR. ${ask}`);
  },
};

const instructionApproval: Requirement = {
  name: "Instruction-file approval",
  evaluate({ instructionFiles, comments }) {
    if (instructionFiles === null)
      return met("no AGENTS.md or CLAUDE.md changes");
    const line = `${APPROVAL_PREFIX} ${instructionFiles.approvalHash}`;
    const approved = comments.some((comment) => {
      const body = lines(comment.body);
      return (
        !comment.isBot &&
        speaksForRepo(comment) &&
        body.includes(line) &&
        body.some((l) => APPROVED_IN.test(l))
      );
    });
    if (approved)
      return met(
        `Lee approved the exact text of ${instructionFiles.paths.join(", ")}`
      );
    return unmet(
      `The PR changes ${instructionFiles.paths.join(", ")}. Show Lee that exact text in a T3 thread. Once Lee approves it there, the agent that showed it posts one comment with these lines, Lee's words quoted. Never post it without Lee's approval in chat:`,
      [line, "approved-in: <T3 thread id>", "> <Lee's words>"]
    );
  },
};

export const REQUIREMENTS: readonly Requirement[] = [
  openAndMergeable,
  autoMerge,
  checks,
  reviewThreads,
  reviewDecision,
  verdict,
  codexReview,
  instructionApproval,
];

export const evaluate = (facts: Facts): readonly Evaluation[] =>
  REQUIREMENTS.map((requirement) => ({
    name: requirement.name,
    result: requirement.evaluate(facts),
  }));

export const missingNames = (evaluations: readonly Evaluation[]): string[] =>
  evaluations.filter((entry) => !entry.result.met).map((entry) => entry.name);

export function renderEvaluations(
  header: string,
  evaluations: readonly Evaluation[]
): string {
  const out = [header];
  for (const { name, result } of evaluations) {
    if (result.met) continue;
    out.push(`missing: ${name}. ${result.missing}`);
    for (const detail of result.details ?? []) out.push(`  ${detail}`);
  }
  for (const { name, result } of evaluations)
    if (result.met) out.push(`met: ${name} (${result.note})`);
  return `${out.join("\n")}\n`;
}
