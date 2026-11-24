import {
  type ActingClient,
  deriveStage,
  GitHubError,
  type IssueRef,
  type IssueSnapshot,
  issueOfBranch,
  readIssueSnapshot,
  type Repo,
  type Stage,
} from "../github/index.ts";
import {
  closedAsDelivered,
  currentReview,
  type FixReason,
  isDeliveryStage,
  type NextAction,
  readPendingReport,
  shapeNextAction,
} from "../stages/index.ts";

/** The stage to run for an Issue, on the first Assignee's runner. */
export interface IssueRoute {
  stage: "shape" | "deliver" | "review";
  reason: FixReason | null;
  /** The first Assignee's user id. */
  assignee: number;
}

/** An Issue's route, whether it is open, and its derived stage for the log. */
export interface RouteState {
  open: boolean;
  route: IssueRoute | null;
  stage: Stage;
}

const nothing: NextAction = { stage: null, reason: null };

/**
 * The next action GitHub state asks for, composed from the stages' own rules:
 * `shape` → Shape; a delivery stage with a pending `shape-wrong` report → Deliver
 * (its start removes `shaped`); `review` with a current review comment → the Deliver
 * `review` fix; any other delivery stage → `shapeNextAction`; closed as delivered →
 * review (wake only); anything else → none.
 */
async function nextFor(
  client: ActingClient,
  issue: IssueRef,
  snapshot: IssueSnapshot,
  stage: Stage,
  log: (line: string) => void,
): Promise<NextAction> {
  if (stage.stage === "shape") {
    return { stage: "shape", reason: null };
  }
  if (isDeliveryStage(stage)) {
    if (await readPendingReport(client, issue, log)) {
      return { stage: "deliver", reason: null };
    }
    if (stage.stage === "review") {
      const review = await currentReview(client, issue, stage.pullRequest);
      if (review?.current === true) {
        return { stage: "deliver", reason: "review" };
      }
    }
    return shapeNextAction(stage, issue.number);
  }
  const closed = stage.stage === "ineligible" && stage.reason === "closed";
  if (closed && (await closedAsDelivered(client, issue, snapshot))) {
    return { stage: "review", reason: null };
  }
  return nothing;
}

/** Reads the Issue and derives what runs next for it (see `routeIssue`). */
export async function readRoute(
  client: ActingClient,
  repo: Repo,
  issue: number,
  log: (line: string) => void,
): Promise<RouteState> {
  const snapshot = await readIssueSnapshot(client, repo, issue);
  const stage = deriveStage(snapshot);
  const ref = { ...repo, number: issue };
  const next = await nextFor(client, ref, snapshot, stage, log);
  const assignee = snapshot.issue.assignees.at(0)?.id;
  const open = snapshot.issue.state === "open";
  if (next.stage === null || assignee === undefined) {
    return { open, route: null, stage };
  }
  return { open, route: { stage: next.stage, reason: next.reason, assignee }, stage };
}

/**
 * The one authority for what runs next for an Issue (#674): the stage, its reason
 * and the first Assignee's user id, or `null` when nothing should run (paused,
 * `pending`, no scope, blocked, no Assignee, waiting for CI or CD, …).
 */
export async function routeIssue(
  client: ActingClient,
  repo: Repo,
  issue: number,
  log: (line: string) => void,
): Promise<IssueRoute | null> {
  return (await readRoute(client, repo, issue, log)).route;
}

/** What an event names: an Issue, or a commit or branch to map to one. */
export type RouteTarget = { issue: number } | { sha: string } | { branch: string };

/**
 * The Issue of an event target: the Issue itself; the Issue of a
 * `nibfin/issue-<n>[-cd-<k>]` branch; or for a commit, the Issue of the first open or
 * merged pull request of `GET /commits/{sha}/pulls` whose head is such a branch.
 * `undefined` when the target belongs to no Issue.
 */
export async function routeEvent(
  client: ActingClient,
  repo: Repo,
  target: RouteTarget,
): Promise<number | undefined> {
  if ("issue" in target) {
    return target.issue;
  }
  if ("branch" in target) {
    return issueOfBranch(target.branch);
  }
  const operation = `list pull requests of ${repo.owner}/${repo.repo}@${target.sha}`;
  let pulls;
  try {
    pulls = await client.paginate(
      "GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls",
      {
        ...repo,
        commit_sha: target.sha,
        per_page: 100,
      },
    );
  } catch (error) {
    throw new GitHubError("GITHUB_READ_FAILED", operation, error);
  }
  for (const pull of pulls) {
    const issue = issueOfBranch(pull.head.ref);
    const live = pull.state === "open" || pull.merged_at !== null;
    if (live && issue !== undefined) {
      return issue;
    }
  }
  return undefined;
}
