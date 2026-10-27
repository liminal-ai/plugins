import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Repository } from "../watch-pr/types.ts";
import type {
  AuthorAssociation,
  HeadCheck,
  IssueComment,
  OpenThread,
  PrRef,
  PullRequest,
} from "./gate.ts";
import type { GitHub, WriteAttempt, MergeReadBack } from "./github.ts";
import type { Runtime } from "./cli.ts";

export const REPO = "owner/repo";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * A remote that stands in for GitHub: it serves any commit by SHA, including ones no ref points at,
 * and a clone (`gate`) whose origin URL names github.com/owner/repo but resolves to that remote.
 */
export interface Repos {
  readonly gate: string;
  readonly remote: string;
  readonly git: (cwd: string, ...args: string[]) => string;
  /** main's original root. */
  readonly c0: string;
  /** main's tip. */
  readonly main: string;
  /** The feature on the old base, later force-pushed away: fetchable only by SHA. */
  readonly oldHead: string;
  /** The same feature rebased onto main. */
  readonly head: string;
  /** The rebased feature with different code. */
  readonly changedHead: string;
  /** The feature plus AGENTS.md and sub/Claude.md, first text. */
  readonly instructionHead: string;
  /** The feature plus the instruction files with edited text. */
  readonly editedInstructionHead: string;
}

export function makeRepos(): Repos {
  const root = mkdtempSync(join(tmpdir(), "merge-gate-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  const gate = join(root, "gate");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
  git(root, "init", "--quiet", "--initial-branch=main", work);

  const commit = (files: Record<string, string>, message: string): string => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), text);
      git(work, "add", path);
    }
    git(work, "commit", "--quiet", "-m", message);
    return git(work, "rev-parse", "HEAD");
  };
  const branchFrom = (base: string): void => {
    git(work, "checkout", "--quiet", "--detach", base);
  };

  const c0 = commit({ "README.md": "root\n" }, "root");
  const oldHead = commit({ "a.txt": "one\n" }, "feature");
  branchFrom(c0);
  const main = commit({ "other.txt": "main moved\n" }, "main moves");
  const head = commit({ "a.txt": "one\n" }, "feature, rebased");
  branchFrom(main);
  const changedHead = commit({ "a.txt": "two\n" }, "feature, changed");
  branchFrom(head);
  const instructionHead = commit(
    { "AGENTS.md": "v1\n", "sub/Claude.md": "c1\n" },
    "instructions v1"
  );
  branchFrom(head);
  const editedInstructionHead = commit(
    { "AGENTS.md": "v2\n", "sub/Claude.md": "c1\n" },
    "instructions v2"
  );

  git(
    work,
    "push",
    "--quiet",
    remote,
    `${main}:refs/heads/main`,
    `${c0}:refs/heads/parent`
  );
  for (const [index, sha] of [
    oldHead,
    head,
    changedHead,
    instructionHead,
    editedInstructionHead,
  ].entries()) {
    git(work, "push", "--quiet", remote, `${sha}:refs/tmp/${index}`);
    git(remote, "update-ref", "-d", `refs/tmp/${index}`);
  }

  git(root, "init", "--quiet", gate);
  git(gate, "remote", "add", "origin", "https://github.com/owner/repo.git");
  git(
    gate,
    "config",
    `url.${join(root, "remote")}.insteadOf`,
    "https://github.com/owner/repo"
  );
  return {
    gate,
    remote,
    git,
    c0,
    main,
    oldHead,
    head,
    changedHead,
    instructionHead,
    editedInstructionHead,
  };
}

export function passing(
  name = "ci",
  app: string | null = "github-actions"
): HeadCheck {
  return {
    app,
    kind: "passed",
    name,
    reportedState: "SUCCESS",
    description: "",
    link: "",
    workflow: "",
  };
}
export function failing(
  name = "ci",
  app: string | null = "github-actions"
): HeadCheck {
  return {
    app,
    kind: "failed",
    name,
    reportedState: "FAILURE",
    description: "",
    link: "",
    workflow: "",
  };
}
export function running(
  name = "ci",
  app: string | null = "github-actions"
): HeadCheck {
  return {
    app,
    kind: "pending",
    name,
    reportedState: "PENDING",
    description: "",
    link: "",
    workflow: "",
  };
}

let commentTime = 0;
export function comment(
  body: string,
  author = "leegmoore",
  isBot = false,
  association: AuthorAssociation = isBot ? "NONE" : "MEMBER"
): IssueComment {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, commentTime++)).toISOString();
  return {
    id: commentTime,
    author,
    isBot,
    association,
    body,
    createdAt: at,
    updatedAt: at,
    url: `https://github.com/owner/repo/pull/1#issuecomment-${commentTime}`,
  };
}
export const verdictComment = (
  outcome: string,
  head: string,
  base: string
): IssueComment =>
  comment(
    `Reviewed.\npstack-verdict: ${outcome} head=${head} base=${base} by=codex/gpt-6.1-sol`,
    "leegmoore"
  );
export const codexComment = (sha: string, status = "completed"): IssueComment =>
  comment(
    `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${sha}","has_any_findings":false,"status":"${status}"},"security_review":{"commit_sha":null}} -->\n\n## Codex Review Summary`,
    "chatgpt-codex-connector[bot]",
    true
  );

export interface FakeOptions {
  readonly defaultBranch?: string;
  readonly mergeQueue?: boolean;
  readonly pull: Partial<PullRequest> & { readonly headRefOid: string };
  /** What every read after the first returns, as when the PR changes between evaluation and merge. */
  readonly atMerge?: {
    readonly pull?: Partial<PullRequest>;
    readonly checks?: readonly HeadCheck[];
    readonly threads?: readonly OpenThread[];
    readonly comments?: readonly IssueComment[];
  };
  readonly checks?: readonly HeadCheck[];
  readonly threads?: readonly OpenThread[];
  readonly comments?: readonly IssueComment[];
  readonly merge?: WriteAttempt;
  readonly comment?: WriteAttempt;
  readonly readBack?: Partial<MergeReadBack>;
  /** The repo's merge brief; null when it has none. */
  readonly mergeBrief?: string | null;
  readonly failOn?: keyof GitHub;
}

export function fakeGitHub(
  options: FakeOptions
): GitHub & { readonly calls: string[] } {
  const calls: string[] = [];
  const step = (name: keyof GitHub, repo: Repository, detail = ""): void => {
    calls.push(`${name} ${repo.owner}/${repo.repo}${detail}`);
    if (options.failOn === name) throw new Error(`${name} failed`);
  };
  const later = (name: keyof GitHub): boolean =>
    calls.filter((call) => call.startsWith(`${name} `)).length > 1;
  return {
    calls,
    async mergeBrief(repo) {
      step("mergeBrief", repo);
      return options.mergeBrief ?? null;
    },
    async defaultBranch(repo) {
      step("defaultBranch", repo);
      return options.defaultBranch ?? "main";
    },
    async usesMergeQueue(repo, branch) {
      step("usesMergeQueue", repo, ` ${branch}`);
      return options.mergeQueue ?? false;
    },
    async pullRequest(pr: PrRef) {
      step("pullRequest", pr, `#${pr.number}`);
      return {
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        baseRefName: "main",
        reviewDecision: null,
        autoMergeArmed: false,
        body: "",
        ...options.pull,
        ...(later("pullRequest") ? options.atMerge?.pull : {}),
      };
    },
    async checks(repo, head) {
      step("checks", repo, ` ${head}`);
      return (
        (later("checks") ? options.atMerge?.checks : undefined) ??
        options.checks ?? [passing()]
      );
    },
    async openThreads(pr) {
      step("openThreads", pr, `#${pr.number}`);
      return (
        (later("openThreads") ? options.atMerge?.threads : undefined) ??
        options.threads ??
        []
      );
    },
    async issueComments(pr) {
      step("issueComments", pr, `#${pr.number}`);
      return (
        (later("issueComments") ? options.atMerge?.comments : undefined) ??
        options.comments ??
        []
      );
    },
    async comment(pr, body) {
      step("comment", pr, `#${pr.number} ${body}`);
      return options.comment ?? { ok: true };
    },
    async merge(pr, head, method) {
      step("merge", pr, `#${pr.number} ${head} ${method}`);
      return options.merge ?? { ok: true };
    },
    async readBack(pr) {
      step("readBack", pr, `#${pr.number}`);
      return {
        state: "MERGED",
        mergedAt: "2026-01-01T00:00:00Z",
        baseRefName: "main",
        mergeCommit: "f".repeat(40),
        ...options.readBack,
      };
    },
  };
}

export function runtimeFor(
  github: GitHub,
  cwd: string
): Runtime & {
  readonly out: () => string;
  /** The output after the merge brief block that every run prints first. */
  readonly decision: () => string;
  readonly store: string;
} {
  const chunks: string[] = [];
  const out = () => chunks.join("");
  return {
    github,
    cwd,
    store: mkdtempSync(join(tmpdir(), "merge-gate-store-")),
    now: () => new Date("2026-10-17T12:00:00.000Z"),
    stdout: (text) => chunks.push(text),
    stderr: (text) => chunks.push(text),
    out,
    decision: () => out().slice(out().indexOf("\n\n") + 2),
  };
}
