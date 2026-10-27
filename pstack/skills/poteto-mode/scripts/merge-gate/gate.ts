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
  readonly body: string;
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

export type BoxStatus = "done" | "n/a" | "skipped" | "changed";

/** One `box <id>: <status>. <note>` line under a verdict. A changed box's note is `<who accepted the change>, <why>`. */
export interface VerdictBox {
  readonly id: string;
  readonly status: BoxStatus;
  readonly note: string;
}

/** A skipped box the lead accepts, given as `--accept-skip <id>=<reason>` on the run that merges. */
export interface Waiver {
  readonly id: string;
  readonly reason: string;
}

/** A missing gate check the lead accepts, given as `--waive <check>=<reason>` on the run that merges. */
export interface CheckWaiver {
  readonly check: string;
  readonly reason: string;
}

/** A plan file and the PR id that ends its section's title, as --plan and --plan-pr or a PR body's pstack-plan line give them. */
export interface PlanRef {
  readonly path: string;
  readonly pr: string;
}

/** The plan the run checks: the one passed, else the one the PR body declares. */
export type PlanFact =
  | { readonly kind: "none" }
  | {
      readonly kind: "read";
      readonly boxes: PlanBoxes;
      readonly declared: boolean;
    }
  | { readonly kind: "declared-missing"; readonly declared: PlanRef }
  | {
      readonly kind: "mismatch";
      readonly declared: PlanRef;
      readonly passed: PlanRef;
    };

/** The required verify boxes of the PR's section in its plan, as check-plan.mjs names them. */
export interface PlanBoxes {
  readonly path: string;
  readonly pr: string;
  readonly ids: readonly string[];
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
      readonly boxes: readonly VerdictBox[];
      readonly unreadBoxLines: readonly string[];
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
  readonly plan: PlanFact;
  readonly waivers: readonly Waiver[];
  readonly checkWaivers: readonly CheckWaiver[];
  readonly instructionFiles: InstructionFiles | null;
}

export type Result =
  | {
      readonly met: true;
      readonly note: string;
      readonly details?: readonly string[];
    }
  | {
      readonly met: false;
      readonly missing: string;
      readonly details?: readonly string[];
    };

export interface Requirement {
  readonly name: string;
  /** The id a lead names in `--waive <id>=<reason>`; absent for a check no lead may waive. */
  readonly waiver?: string;
  readonly evaluate: (facts: Facts) => Result;
}

export interface Evaluation {
  readonly name: string;
  readonly waiver?: string;
  readonly result: Result;
}

const VERDICT_PREFIX = "pstack-verdict:";
const VERDICT_LINE =
  /^pstack-verdict: (PASS\+NOTES|PASS|FAIL) head=([0-9a-f]{40}) base=([0-9a-f]{40}) by=(\S+)$/;
export const BOX_ID = /^[a-z]+(?:-\d+)?$/;
const BOX_LINE =
  /^(?:[-*] )?box ([a-z]+(?:-\d+)?): (done|n\/a|skipped|changed)(?:\. (.*))?$/;
const BOX_PREFIX = /^(?:[-*] )?box /;
const PLAN_PREFIX = "pstack-plan:";
const PLAN_DECLARATION = /^pstack-plan: (\S(?:.*\S)?) pr=(\S+)$/;
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

/**
 * The most recent comment with a verdict line decides; its last such line counts, with the lines below it.
 * An edit can leave an older verdict and its boxes above, and those belong to that older verdict.
 */
export function findVerdictLine(comments: readonly IssueComment[]): {
  readonly line: string;
  readonly below: readonly string[];
  readonly url: string;
} | null {
  for (const comment of [...comments].sort(newestFirst)) {
    const all = lines(comment.body);
    const at = all.findLastIndex((line) => line.startsWith(VERDICT_PREFIX));
    if (at !== -1)
      return { line: all[at], below: all.slice(at + 1), url: comment.url };
  }
  return null;
}

/** The box lines under a verdict line, and any line that starts like one but does not parse. */
export function parseBoxLines(below: readonly string[]): {
  readonly boxes: readonly VerdictBox[];
  readonly unread: readonly string[];
} {
  const boxes: VerdictBox[] = [];
  const unread: string[] = [];
  for (const line of below.map(readable)) {
    if (!BOX_PREFIX.test(line)) continue;
    const match = BOX_LINE.exec(line);
    if (match === null) unread.push(line);
    else
      boxes.push({
        id: match[1],
        status: match[2] as BoxStatus,
        note: match[3]?.trim() ?? "",
      });
  }
  return { boxes, unread };
}

/**
 * The PR body's one `pstack-plan: <path> pr=<id>` line; the path may hold spaces. Any line that starts
 * `pstack-plan:`, in a code block or not, counts. Two of them, or one that does not parse, come back as
 * `{ malformed }`, so no declared plan is ever dropped or outranked silently.
 */
export function declaredPlan(
  body: string
): PlanRef | { readonly malformed: string } | null {
  const declared = lines(body).filter((line) => line.startsWith(PLAN_PREFIX));
  if (declared.length === 0) return null;
  if (declared.length > 1)
    return { malformed: `${declared.length} plan lines (${declared.join(" | ")}); a PR declares one plan` };
  const match = PLAN_DECLARATION.exec(declared[0]);
  return match === null ? { malformed: declared[0] } : { path: match[1], pr: match[2] };
}

/** Who accepted a changed bar and why, read from the note `<who>, <why>`; null unless both are there. */
export function barChange(
  note: string
): { readonly who: string; readonly why: string } | null {
  const at = note.indexOf(",");
  const who = note.slice(0, at).trim();
  const why = note.slice(at + 1).trim();
  return at === -1 || who === "" || why === "" ? null : { who, why };
}

/** Each waiver for a box the verdict did not skip or a check that holds; the run that gave it is a usage error. */
export function strayWaivers(facts: Facts): string[] {
  const { verdict } = facts;
  const boxes =
    verdict.kind !== "found"
      ? []
      : facts.waivers
          .filter(
            (waiver) =>
              !verdict.boxes.some(
                (box) => box.id === waiver.id && box.status === "skipped"
              )
          )
          .map(
            (waiver) =>
              `--accept-skip ${waiver.id}: the verdict (${verdict.url}) does not skip box ${waiver.id}`
          );
  const checks = facts.checkWaivers.flatMap((waiver) => {
    const requirement = REQUIREMENTS.find((r) => r.waiver === waiver.check);
    return requirement === undefined || !requirement.evaluate(facts).met
      ? []
      : [
          `--waive ${waiver.check}: ${requirement.name} is met, so there is nothing to waive`,
        ];
  });
  return [...boxes, ...checks];
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

const met = (note: string, details?: readonly string[]): Result => ({
  met: true,
  note,
  ...(details === undefined ? {} : { details }),
});
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
  waiver: "checks",
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
  waiver: "threads",
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

export const BOX_FORMS =
  '"box <id>: done", "box <id>: n/a. <reason>", "box <id>: skipped. <what did not run>" or "box <id>: changed. <who accepted the changed bar>, <why>"';

const planBoxes: Requirement = {
  name: "Plan boxes",
  evaluate({ verdict: fact, plan: planFact, waivers }) {
    if (planFact.kind === "declared-missing") {
      const { path, pr } = planFact.declared;
      return unmet(
        `The PR body declares the plan ${path} for ${pr}, and it is not on this machine. Run the gate from where that path resolves, or pass the plan's path here:`,
        [`--plan ${path} --plan-pr ${pr}`]
      );
    }
    if (planFact.kind === "mismatch") {
      const { declared, passed } = planFact;
      return unmet(
        "--plan and --plan-pr name another plan than the PR body declares. Pass the declared plan, or fix the PR body's pstack-plan line:",
        [
          `declared: pstack-plan: ${declared.path} pr=${declared.pr}`,
          `passed: --plan ${passed.path} --plan-pr ${passed.pr}`,
        ]
      );
    }
    const plan = planFact.kind === "read" ? planFact.boxes : null;
    const noPlan =
      planFact.kind === "none"
        ? ["No plan checked: the PR declares none and none was passed."]
        : [];
    if (fact.kind !== "found")
      return met("no verdict to read; see Independent verdict", noPlan);
    const listed = new Set(fact.boxes.map((box) => box.id));
    const repeated = [...listed].filter(
      (id) => fact.boxes.filter((box) => box.id === id).length > 1
    );
    const omitted = (plan?.ids ?? []).filter((id) => !listed.has(id));
    const noReason = fact.boxes.filter(
      (box) => (box.status === "n/a" || box.status === "skipped") && box.note === ""
    );
    const changed = fact.boxes.filter((box) => box.status === "changed");
    const unowned = changed.filter((box) => barChange(box.note) === null);
    // Every agent posts as the same GitHub account, so no comment can say the lead accepted a skip; only the lead's own gate run can.
    const waived = new Set(waivers.map((waiver) => waiver.id));
    const unwaived = fact.boxes.filter(
      (box) => box.status === "skipped" && !waived.has(box.id)
    );
    const parts: string[] = [];
    const details: string[] = [];
    if (fact.unreadBoxLines.length > 0) {
      parts.push(
        `${fact.unreadBoxLines.length} box line${fact.unreadBoxLines.length === 1 ? " does" : "s do"} not read as ${BOX_FORMS}`
      );
      details.push(...fact.unreadBoxLines.map((line) => `unread: ${line}`));
    }
    if (repeated.length > 0) {
      parts.push(
        `${repeated.length} box${repeated.length === 1 ? " is" : "es are"} listed more than once, so the verdict does not say which status holds. Have the verifier list each box once`
      );
      details.push(`listed more than once: ${repeated.join(" ")}`);
    }
    if (omitted.length > 0) {
      parts.push(
        `The verdict omits ${omitted.length} required box${omitted.length === 1 ? "" : "es"} of ${plan?.pr} in ${plan?.path}. Have the verifier list each one as ${BOX_FORMS}`
      );
      details.push(`omitted: ${omitted.join(" ")}`);
    }
    if (noReason.length > 0) {
      parts.push(
        `${noReason.length} box${noReason.length === 1 ? " is" : "es are"} n/a or skipped with no reason. Have the verifier give one`
      );
      details.push(`no reason: ${noReason.map((box) => box.id).join(" ")}`);
    }
    if (unowned.length > 0) {
      parts.push(
        `${unowned.length} changed box${unowned.length === 1 ? " does" : "es do"} not name who accepted the changed bar and why. Have the verifier write "box <id>: changed. <who>, <why>"`
      );
      details.push(`no who and why: ${unowned.map((box) => box.id).join(" ")}`);
    }
    if (unwaived.length > 0) {
      parts.push(
        `${unwaived.length} skipped box${unwaived.length === 1 ? " is" : "es are"} not waived by the lead, so the verdict is not a pass. Run the box and get a new verdict, or, if the lead accepts the skip, the lead runs the gate with "--accept-skip <id>=<reason>"`
      );
      details.push(`not waived: ${unwaived.map((box) => box.id).join(" ")}`);
    }
    if (parts.length > 0)
      return unmet(`${parts.join(". ")}. (${fact.url})`, details);
    const skipped = fact.boxes.filter((box) => box.status === "skipped").length;
    const scope =
      plan === null
        ? `no plan given, ${fact.boxes.length} box${fact.boxes.length === 1 ? "" : "es"} listed`
        : `all ${plan.ids.length} required boxes of ${plan.pr} listed${planFact.kind === "read" && planFact.declared ? `, from the plan the PR body declares` : ""}`;
    const notes = [
      scope,
      ...(skipped === 0
        ? []
        : [`${skipped} skip${skipped === 1 ? "" : "s"} waived by the lead`]),
      ...(changed.length === 0
        ? []
        : [`${changed.length} bar${changed.length === 1 ? "" : "s"} changed`]),
    ];
    const changes = changed.flatMap((box) => {
      const change = barChange(box.note);
      return change === null
        ? []
        : [`changed: box ${box.id}, accepted by ${change.who}: ${change.why}`];
    });
    const notesBelow = [...noPlan, ...changes];
    return met(
      notes.join(", "),
      notesBelow.length === 0 ? undefined : notesBelow
    );
  },
};

const codexReview: Requirement = {
  name: "Codex review",
  waiver: "codex",
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
  planBoxes,
  codexReview,
  instructionApproval,
];

export const WAIVABLE_CHECKS: readonly string[] = REQUIREMENTS.flatMap(
  (requirement) => (requirement.waiver === undefined ? [] : [requirement.waiver])
);

/** Each requirement's result, a missing check the lead waived counting as met with its reason. */
export const evaluate = (facts: Facts): readonly Evaluation[] =>
  REQUIREMENTS.map(({ name, waiver, evaluate: judge }) => {
    const result = judge(facts);
    const waived = facts.checkWaivers.find((entry) => entry.check === waiver);
    return {
      name,
      waiver,
      result:
        result.met || waived === undefined
          ? result
          : met(
              `waived by the lead: ${waived.reason}; unmet: ${result.missing}`,
              result.details
            ),
    };
  });

export const missingNames = (evaluations: readonly Evaluation[]): string[] =>
  evaluations.filter((entry) => !entry.result.met).map((entry) => entry.name);

export function renderEvaluations(
  header: string,
  evaluations: readonly Evaluation[]
): string {
  const out = [header];
  for (const { name, waiver, result } of evaluations) {
    if (result.met) continue;
    out.push(`missing: ${name}. ${result.missing}`);
    for (const detail of result.details ?? []) out.push(`  ${detail}`);
    if (waiver !== undefined)
      out.push(
        `  If the lead accepts merging without it, the lead runs the gate with --waive ${waiver}=<reason>.`
      );
  }
  for (const { name, result } of evaluations) {
    if (!result.met) continue;
    out.push(`met: ${name} (${result.note})`);
    for (const detail of result.details ?? []) out.push(`  ${detail}`);
  }
  return `${out.join("\n")}\n`;
}
