import {
  type Facts,
  type HashResult,
  type PlanBoxes,
  type PrRef,
  type VerdictFact,
  findSignedSkips,
  findVerdictLine,
  hasVerdictLine,
  isInstructionFile,
  parseBoxLines,
  parseVerdictLine,
  speaksForRepo,
} from "./gate.ts";
import type { Git } from "./git.ts";
import { ReadError } from "./git.ts";
import type { GitHub } from "./github.ts";

/** Reads every fact once. Throws on any read it cannot vouch for, so a read error never passes. */
export async function readFacts(
  github: GitHub,
  git: Git,
  pr: PrRef,
  plan: PlanBoxes | null = null
): Promise<Facts> {
  const remote = git.remoteFor(pr);
  const [defaultBranch, pull, comments] = await Promise.all([
    github.defaultBranch(pr),
    github.pullRequest(pr),
    github.issueComments(pr),
  ]);
  const head = pull.headRefOid;
  const [checks, threads, baseUsesMergeQueue] = await Promise.all([
    github.checks(pr, head),
    github.openThreads(pr),
    github.usesMergeQueue(pr, pull.baseRefName),
  ]);

  const baseTip = git.branchTip(remote, pull.baseRefName);
  git.fetch(remote, [baseTip, head]);
  const mergeBase = git.mergeBase(baseTip, head);
  const currentHash = git.verdictHash(mergeBase, head);

  const found = findVerdictLine(comments.filter(speaksForRepo));
  let verdict: VerdictFact = {
    kind: "none",
    ignored: comments
      .filter((comment) => !speaksForRepo(comment) && hasVerdictLine(comment))
      .map(({ author, association, url }) => ({ author, association, url })),
  };
  if (found !== null) {
    const parsed = parseVerdictLine(found.line);
    const { boxes, unread } = parseBoxLines(found.below);
    verdict =
      parsed === null
        ? { kind: "malformed", line: found.line, url: found.url }
        : {
            kind: "found",
            ...parsed,
            url: found.url,
            recordedHash: recordedHash(git, remote, parsed.base, parsed.head),
            boxes,
            unreadBoxLines: unread,
          };
  }

  const instructionPaths = git
    .changedPaths(mergeBase, head)
    .filter(isInstructionFile);
  return {
    pr,
    defaultBranch,
    baseUsesMergeQueue,
    pull,
    checks,
    threads,
    comments,
    mergeBase,
    currentHash,
    verdict,
    plan,
    skips: findSignedSkips(comments, found?.comment ?? null),
    instructionFiles:
      instructionPaths.length === 0
        ? null
        : {
            paths: instructionPaths,
            approvalHash: git.diffHash(mergeBase, head, instructionPaths),
          },
  };
}

function recordedHash(
  git: Git,
  remote: string,
  base: string,
  head: string
): HashResult {
  try {
    git.fetch(remote, [base, head]);
  } catch (error) {
    if (!(error instanceof ReadError)) throw error;
    return {
      ok: false,
      detail: `its commits could not be fetched: ${error.message}`,
    };
  }
  return git.verdictHash(base, head);
}
