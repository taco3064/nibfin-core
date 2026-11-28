import {
  type ActingClient,
  type Actor,
  deriveStage,
  type IssueRef,
  type IssueSnapshot,
  issueOfBranch,
  issuesOfCommit,
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
  pendingChoice,
  readChoice,
  readApprovalWait,
  readPendingReport,
  readRepairNeed,
  type RepairNeed,
  shapeNextAction,
} from "../stages/index.ts";

/**
 * The stage to run for an Issue; `dispatchStage` runs it on a runner of one of its
 * Assignees (#739).
 */
export interface IssueRoute {
  stage: "scope" | "shape" | "deliver" | "review" | "finish";
  reason: FixReason | null;
  /**
   * All the Issue's Assignees in GitHub's order, never empty: the candidates
   * `dispatchStage` chooses from (#739) and the ones asked for consent (#721).
   */
  assignees: readonly Actor[];
}

/**
 * An Issue's route, whether it is open, its derived stage for the log, its Assignees
 * in GitHub's order (the repair agent's candidates, #778), and for an Issue that
 * derives `ineligible (pending)` its repair need (#777; `null` otherwise or when
 * there is nothing to repair).
 */
export interface RouteState {
  open: boolean;
  route: IssueRoute | null;
  stage: Stage;
  assignees: readonly Actor[];
  repair: RepairNeed | null;
}

const nothing: NextAction = { stage: null, reason: null };

/**
 * The next action GitHub state asks for, composed from the stages' own rules:
 * `scope` → Scope (#734); `shape` → Shape; a delivery stage with a choice on a
 * repair record not yet applied → Shape (it applies the choice first, #779); a
 * delivery stage with a pending `shape-wrong` report → Deliver (its start removes
 * `shaped`); `review` with a current review comment → the Deliver `review` fix;
 * `review` whose current `approval-wait` comment still waits for approvals → none (a
 * submitted review wakes it); `review` whose current `approval-wait` comment has its
 * approvals or a writer's request for changes on the head → finish (the Shape review
 * already passed, so no agent runs); any other delivery stage → `shapeNextAction`
 * (`done` → finish); closed as delivered → finish (wake only); anything else → none.
 */
async function nextFor(
  client: ActingClient,
  issue: IssueRef,
  snapshot: IssueSnapshot,
  stage: Stage,
  log: (line: string) => void,
): Promise<NextAction> {
  if (stage.stage === "scope") {
    return { stage: "scope", reason: null };
  }
  if (stage.stage === "shape") {
    return { stage: "shape", reason: null };
  }
  if (isDeliveryStage(stage)) {
    if (pendingChoice(await readChoice(client, issue))) {
      return { stage: "shape", reason: null };
    }
    if (await readPendingReport(client, issue, log)) {
      return { stage: "deliver", reason: null };
    }
    if (stage.stage === "review") {
      const review = await currentReview(client, issue, stage.pullRequest);
      if (review?.current === true) {
        return { stage: "deliver", reason: "review" };
      }
      const wait = await readApprovalWait(client, issue, stage.pullRequest);
      if (wait?.kind === "waiting") {
        return nothing;
      }
      if (wait !== undefined) {
        return { stage: "finish", reason: null };
      }
    }
    return shapeNextAction(stage, issue.number);
  }
  const closed = stage.stage === "ineligible" && stage.reason === "closed";
  if (closed && (await closedAsDelivered(client, issue, snapshot))) {
    return { stage: "finish", reason: null };
  }
  return nothing;
}

/**
 * Reads the Issue and derives what runs next for it (see `routeIssue`). A route has
 * at least one Assignee; with several, all are candidates (#739). An Issue that
 * derives `ineligible (pending)` also gets its repair need (`readRepairNeed`).
 */
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
  const { assignees } = snapshot.issue;
  const open = snapshot.issue.state === "open";
  const pending = stage.stage === "ineligible" && stage.reason === "pending";
  const repair = pending ? await readRepairNeed(client, ref) : null;
  if (next.stage === null || assignees.length === 0) {
    return { open, route: null, stage, assignees, repair };
  }
  const route = { stage: next.stage, reason: next.reason, assignees };
  return { open, route, stage, assignees, repair };
}

/**
 * The one authority for what runs next for an Issue (#674): the stage, its reason
 * and the Issue's Assignees in GitHub's order (`dispatchStage` chooses one, #739),
 * or `null` when nothing should run (paused, `pending`, no scope, blocked, no
 * Assignee, waiting for CI or CD, …).
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
 * The Issues of an event target, without repeats: the Issue itself; the Issue of a
 * `nibfin/issue-<n>[-cd-<k>]` branch; or for a commit, the Issues of every open or
 * merged pull request of `GET /commits/{sha}/pulls` whose head is such a branch,
 * then those of every merged pull request whose `merge_commit_sha` is the commit
 * (a pull request that merged without moving the base is not associated with it,
 * #771). Empty when the target belongs to no Issue.
 */
export async function routeEvent(
  client: ActingClient,
  repo: Repo,
  target: RouteTarget,
): Promise<number[]> {
  if ("issue" in target) {
    return [target.issue];
  }
  if ("branch" in target) {
    const issue = issueOfBranch(target.branch);
    return issue === undefined ? [] : [issue];
  }
  return issuesOfCommit(client, repo, target.sha);
}
