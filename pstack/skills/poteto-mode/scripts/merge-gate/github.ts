import {
  at,
  firstLine,
  list,
  mapRollupNode,
  optionalString,
  parsePullRequest,
  record,
  run,
  runJson,
  string,
} from "../watch-pr/github.ts";
import type { Repository } from "../watch-pr/types.ts";
import { ReadError } from "./git.ts";
import {
  AUTHOR_ASSOCIATIONS,
  type AuthorAssociation,
  type HeadCheck,
  type IssueComment,
  type OpenThread,
  type PrRef,
  type PullRequest,
} from "./gate.ts";

export interface MergeReadBack {
  readonly state: string;
  readonly mergedAt: string | null;
  readonly baseRefName: string;
  readonly mergeCommit: string | null;
}

export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export type MergeAttempt =
  { readonly ok: true } | { readonly ok: false; readonly detail: string };

/** The GitHub reads and the one write the gate makes. Every call names the repo; gh never picks one. */
export interface GitHub {
  defaultBranch(repo: Repository): Promise<string>;
  usesMergeQueue(repo: Repository, branch: string): Promise<boolean>;
  pullRequest(pr: PrRef): Promise<PullRequest>;
  checks(repo: Repository, head: string): Promise<readonly HeadCheck[]>;
  openThreads(pr: PrRef): Promise<readonly OpenThread[]>;
  issueComments(pr: PrRef): Promise<readonly IssueComment[]>;
  merge(pr: PrRef, head: string, method: MergeMethod): Promise<MergeAttempt>;
  readBack(pr: PrRef): Promise<MergeReadBack>;
}

const CHECKS_QUERY = `
query HeadChecks($owner: String!, $repo: String!, $oid: GitObjectID!, $after: String) {
  repository(owner: $owner, name: $repo) {
    object(oid: $oid) {
      ... on Commit {
        statusCheckRollup {
          contexts(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              __typename
              ... on CheckRun {
                name status conclusion detailsUrl
                checkSuite { app { slug } workflowRun { event workflow { id } } }
              }
              ... on StatusContext { context state targetUrl }
            }
          }
        }
      }
    }
  }
}
`;

const THREADS_QUERY = `
query OpenThreads($owner: String!, $repo: String!, $pr: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          path
          line
          comments(first: 1) { nodes { body url author { login } } }
        }
      }
    }
  }
}
`;

const MERGE_QUEUE_QUERY = `
query MergeQueue($owner: String!, $repo: String!, $branch: String!) {
  repository(owner: $owner, name: $repo) { mergeQueue(branch: $branch) { id } }
}
`;

/** Only "User" counts as a person; the others are GitHub's documented non-person account types. */
const ACCOUNT_TYPES = new Set(["User", "Bot", "Organization", "Mannequin"]);

const repoName = (repo: Repository): string => `${repo.owner}/${repo.repo}`;

const isAssociation = (value: string): value is AuthorAssociation =>
  (AUTHOR_ASSOCIATIONS as readonly string[]).includes(value);

function graphql(
  query: string,
  repo: Repository,
  variables: Record<string, string>
): Promise<unknown> {
  const argv: [string, ...string[]] = [
    "gh",
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${repo.owner}`,
    "-f",
    `repo=${repo.repo}`,
  ];
  for (const [key, value] of Object.entries(variables))
    argv.push(key === "pr" ? "-F" : "-f", `${key}=${value}`);
  return runJson(argv);
}

/** A page that cannot say whether more follow, or how to get them, is an incomplete read, never the last page. */
function nextCursor(pageInfo: unknown, path: string): string | null {
  const page = record(pageInfo, path);
  if (typeof page.hasNextPage !== "boolean")
    readError(`${path}.hasNextPage is not a boolean`);
  if (!page.hasNextPage) return null;
  if (typeof page.endCursor !== "string" || page.endCursor === "")
    readError(`${path} says another page follows but gives no endCursor`);
  return page.endCursor;
}

/** A check run's app decides whether it is Bugbot's, so a run that cannot name its app is a read error. */
function checkApp(node: unknown, name: string): string | null {
  if (record(node, "check").__typename !== "CheckRun") return null;
  const app = at(node, ["checkSuite", "app"]);
  if (app === null) return null;
  return string(
    record(app, `check ${name} app`).slug,
    `check ${name} app.slug`
  );
}

interface Run {
  readonly check: HeadCheck;
  /** Workflow id, event and check name for an Actions run; null for any other check. */
  readonly key: string | null;
  readonly cancelled: boolean;
}

function readRun(node: unknown, check: HeadCheck): Run {
  const fields = record(node, "check");
  const cancelled = fields.conclusion === "CANCELLED";
  if (fields.__typename !== "CheckRun") return { check, key: null, cancelled };
  const workflowRun = at(node, ["checkSuite", "workflowRun"]);
  if (workflowRun === null) return { check, key: null, cancelled };
  const key = JSON.stringify([
    string(at(workflowRun, ["workflow", "id"]), "workflow.id"),
    string(at(workflowRun, ["event"]), "workflowRun.event"),
    check.name,
  ]);
  return { check, key, cancelled };
}

/**
 * A concurrency group cancels a run when a newer one starts, so a cancelled
 * Actions run with a non-cancelled sibling defers to that sibling, whatever its
 * state. Only cancellations are dropped: ordering runs by number or start time
 * cannot tell a rerun of an older run from a superseded one.
 */
function dropSupersededCancellations(runs: readonly Run[]): HeadCheck[] {
  const decided = new Set(
    runs
      .filter((run) => run.key !== null && !run.cancelled)
      .map((run) => run.key)
  );
  return runs
    .filter((run) => !(run.cancelled && decided.has(run.key)))
    .map((run) => run.check);
}

function readError(detail: string): never {
  throw new ReadError(detail);
}

export class GhGitHub implements GitHub {
  async defaultBranch(repo: Repository): Promise<string> {
    const value = await runJson([
      "gh",
      "repo",
      "view",
      repoName(repo),
      "--json",
      "defaultBranchRef",
    ]);
    return string(
      at(value, ["defaultBranchRef", "name"]),
      "defaultBranchRef.name"
    );
  }

  async usesMergeQueue(repo: Repository, branch: string): Promise<boolean> {
    const value = await graphql(MERGE_QUEUE_QUERY, repo, { branch });
    return at(value, ["data", "repository", "mergeQueue"]) !== null;
  }

  async pullRequest(pr: PrRef): Promise<PullRequest> {
    const value = record(
      await runJson([
        "gh",
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoName(pr),
        "--json",
        "mergeable,mergeStateStatus,reviewDecision,headRefOid,headRefName,baseRefName,state,mergedAt,isDraft,autoMergeRequest",
      ]),
      "pull request"
    );
    const facts = parsePullRequest(value, pr);
    if (facts.headRefOid === null)
      readError(`PR #${pr.number} reports no head commit`);
    if (!("autoMergeRequest" in value))
      readError(`PR #${pr.number} came back without autoMergeRequest`);
    if (value.autoMergeRequest !== null)
      record(value.autoMergeRequest, "pull request.autoMergeRequest");
    return {
      state: facts.state,
      isDraft: facts.isDraft,
      mergeable: facts.mergeable,
      baseRefName: facts.baseRefName,
      headRefOid: facts.headRefOid,
      reviewDecision: facts.reviewDecision,
      autoMergeArmed: value.autoMergeRequest !== null,
    };
  }

  async checks(repo: Repository, head: string): Promise<readonly HeadCheck[]> {
    const runs: Run[] = [];
    let after: string | null = null;
    do {
      const value = await graphql(CHECKS_QUERY, repo, {
        oid: head,
        ...(after === null ? {} : { after }),
      });
      const commit = at(value, ["data", "repository", "object"]);
      if (commit === null) readError(`GitHub does not know commit ${head}`);
      const fields = record(commit, "commit");
      if (!("statusCheckRollup" in fields))
        readError(`commit ${head} came back without statusCheckRollup`);
      const rollup = fields.statusCheckRollup;
      if (rollup === null) return dropSupersededCancellations(runs);
      const contexts = record(
        at(rollup, ["contexts"]),
        "statusCheckRollup.contexts"
      );
      for (const node of list(contexts.nodes, "contexts.nodes")) {
        const check = mapRollupNode(node);
        if (check === null)
          readError(
            `a check on ${head} came back in a shape the gate cannot read`
          );
        runs.push(readRun(node, { ...check, app: checkApp(node, check.name) }));
      }
      after = nextCursor(contexts.pageInfo, "contexts.pageInfo");
    } while (after !== null);
    return dropSupersededCancellations(runs);
  }

  async openThreads(pr: PrRef): Promise<readonly OpenThread[]> {
    const open: OpenThread[] = [];
    let after: string | null = null;
    do {
      const value = await graphql(THREADS_QUERY, pr, {
        pr: String(pr.number),
        ...(after === null ? {} : { after }),
      });
      const threads = record(
        at(value, ["data", "repository", "pullRequest", "reviewThreads"]),
        "reviewThreads"
      );
      for (const node of list(threads.nodes, "reviewThreads.nodes")) {
        const thread = record(node, "review thread");
        if (typeof thread.isResolved !== "boolean")
          readError("review thread.isResolved is not a boolean");
        if (thread.isResolved) continue;
        const first = list(
          at(thread, ["comments", "nodes"]),
          "review thread.comments.nodes"
        )[0];
        const comment =
          first === undefined ? null : record(first, "review comment");
        const author = comment?.author
          ? record(comment.author, "review comment.author")
          : null;
        open.push({
          author:
            author === null
              ? null
              : optionalString(author.login, "author.login"),
          path: optionalString(thread.path ?? null, "review thread.path"),
          line: typeof thread.line === "number" ? thread.line : null,
          body:
            comment === null ? "" : string(comment.body, "review comment.body"),
          url:
            comment === null
              ? null
              : optionalString(comment.url ?? null, "review comment.url"),
        });
      }
      after = nextCursor(threads.pageInfo, "reviewThreads.pageInfo");
    } while (after !== null);
    return open;
  }

  async issueComments(pr: PrRef): Promise<readonly IssueComment[]> {
    const pages = await runJson([
      "gh",
      "api",
      "--paginate",
      "--slurp",
      `repos/${repoName(pr)}/issues/${pr.number}/comments?per_page=100`,
    ]);
    const seen = new Set<number>();
    return list(pages, "comment pages").flatMap((page) =>
      list(page, "comment page").map((item) => {
        const comment = record(item, "comment");
        const user = record(comment.user, "comment.user");
        const id = comment.id;
        if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)
          readError("comment.id is not a positive integer");
        if (seen.has(id)) readError(`comment ${id} appears twice`);
        seen.add(id);
        const login = string(user.login, "comment.user.login");
        if (!/^\S+$/.test(login))
          readError(
            `comment ${id} has an empty or blank login: ${JSON.stringify(login)}`
          );
        const type = string(user.type, "comment.user.type");
        if (!ACCOUNT_TYPES.has(type))
          readError(`comment ${id} has an unknown account type ${type}`);
        const association = string(
          comment.author_association,
          "comment.author_association"
        );
        if (!isAssociation(association))
          readError(
            `comment ${id} has an unknown author_association ${association}`
          );
        return {
          id,
          author: login,
          isBot: type !== "User",
          association,
          body: string(comment.body, "comment.body"),
          createdAt: string(comment.created_at, "comment.created_at"),
          updatedAt: string(comment.updated_at, "comment.updated_at"),
          url: string(comment.html_url, "comment.html_url"),
        };
      })
    );
  }

  async merge(
    pr: PrRef,
    head: string,
    method: MergeMethod
  ): Promise<MergeAttempt> {
    const result = await run([
      "gh",
      "pr",
      "merge",
      String(pr.number),
      "--repo",
      repoName(pr),
      `--${method}`,
      "--match-head-commit",
      head,
    ]);
    if (result.code === 0) return { ok: true };
    return {
      ok: false,
      detail:
        firstLine(result.stderr) ||
        firstLine(result.stdout) ||
        `gh pr merge exited ${result.code}`,
    };
  }

  async readBack(pr: PrRef): Promise<MergeReadBack> {
    const value = record(
      await runJson([
        "gh",
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoName(pr),
        "--json",
        "state,mergedAt,baseRefName,mergeCommit",
      ]),
      "pull request"
    );
    const mergeCommit =
      value.mergeCommit === null
        ? null
        : string(at(value.mergeCommit, ["oid"]), "mergeCommit.oid");
    return {
      state: string(value.state, "state"),
      mergedAt: optionalString(value.mergedAt, "mergedAt"),
      baseRefName: string(value.baseRefName, "baseRefName"),
      mergeCommit,
    };
  }
}
