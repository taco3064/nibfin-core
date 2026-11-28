import {
  type ActingClient,
  type Actor,
  dispatchWorkflow,
  nibfinRunTitle,
  nibfinWorkflowPrefix,
  type QueuedRun,
  readNotStartedRuns,
  readRunners,
  type Repo,
  type RunnerLabels,
  runnerLabel,
} from "../github/index.ts";
import { askForConsent } from "./consent.ts";
import type { FixReason, RepairDispatcher } from "../stages/index.ts";
import type { RouteTarget } from "./event-issues.ts";
import type { IssueRoute } from "./route.ts";

/** The execution repository's workflow that runs every route and stage Job. */
export const sharedRunnerWorkflow = "nibfin-shared-runner.yml";

/** What a route or post-stage run dispatches with. */
export interface DispatchScope {
  client: ActingClient;
  /** The execution repository (`NIBFIN_RUN_REPO`). */
  runRepo: Repo;
  /** This run's id (`NIBFIN_RUN_ID`); never counted as a waiting duplicate. */
  runId: number | undefined;
  log: (line: string) => void;
}

const repoName = (repo: Repo) => `${repo.owner}/${repo.repo}`;

async function dispatch(
  scope: DispatchScope,
  title: string,
  inputs: Record<string, string>,
): Promise<void> {
  const url = await dispatchWorkflow(
    scope.client,
    scope.runRepo,
    sharedRunnerWorkflow,
    inputs,
  );
  scope.log(`Dispatched ${title}${url === undefined ? "" : `: ${url}`}`);
}

/**
 * Dispatches a route run for the target; never deduplicated, so no wake is lost. An
 * Issue is sent as `issue`; a commit as `sha` and a branch as `branch`, each also as
 * `ref`, which names the run `Nibfin · <owner>/<repo>@<ref> · route` as the shared
 * runner does.
 */
export async function dispatchRoute(
  scope: DispatchScope,
  repo: Repo,
  target: RouteTarget,
): Promise<void> {
  const inputs = { stage: "route", repo: repoName(repo) };
  if ("issue" in target) {
    const title = nibfinRunTitle(repo, target.issue, "route");
    await dispatch(scope, title, { ...inputs, issue: String(target.issue) });
    return;
  }
  const [name, ref] = "sha" in target ? ["sha", target.sha] : ["branch", target.branch];
  const title = `${nibfinWorkflowPrefix} ${repoName(repo)}@${ref} · route`;
  await dispatch(scope, title, { ...inputs, [name]: ref, ref });
}

/** The Assignee a stage is dispatched to, and whether one of its runners is online. */
export interface ChosenAssignee {
  assignee: number;
  online: boolean;
}

/**
 * Chooses the Assignee to dispatch to (#739, Proposal R4.20–R4.22): going through
 * `assignees` in order, the first with an online runner labelled `nibfin-<user id>`
 * (exact match on the lowercased label); otherwise the first with any such runner;
 * otherwise `undefined`, an ordinary assignment.
 */
export function chooseAssignee(
  assignees: readonly number[],
  runners: readonly RunnerLabels[],
): ChosenAssignee | undefined {
  const runnersOf = (assignee: number) =>
    runners.filter((runner) => runner.labels.has(runnerLabel(assignee)));
  const online = assignees.find((assignee) =>
    runnersOf(assignee).some((runner) => runner.online),
  );
  if (online !== undefined) {
    return { assignee: online, online: true };
  }
  const any = assignees.find((assignee) => runnersOf(assignee).length > 0);
  return any === undefined ? undefined : { assignee: any, online: false };
}

/** What `planDispatch` plans for: a route's stage, or the repair agent (#778). */
export interface DispatchTarget {
  stage: IssueRoute["stage"] | "repair";
  reason: FixReason | null;
  assignees: readonly Actor[];
}

/**
 * What `planDispatch` found: `none` (no runner of any Assignee, an ordinary
 * assignment), `waiting` (a run with the title has not started yet), `consent`
 * (`pause` and the consent comments were just written) or `ready` (dispatch to
 * `assignee`).
 */
export type DispatchPlan =
  | { kind: "none" }
  | { kind: "waiting"; runId: number }
  | { kind: "consent" }
  | { kind: "ready"; assignee: number };

/** A run of the execution repository with `title` that has not started, not this run. */
export async function findWaitingRun(
  scope: DispatchScope,
  title: string,
): Promise<QueuedRun | undefined> {
  return (await readNotStartedRuns(scope.client, scope.runRepo)).find(
    (run) => run.id !== scope.runId && run.title === title,
  );
}

/**
 * Plans the dispatch of `target`'s stage for the Issue (#739): it lists the execution
 * repository's self-hosted runners and, in GitHub's Assignee order, takes the first
 * Assignee with an online runner labelled `nibfin-<user id>` (case-insensitive, busy
 * or not), else the first with any such runner (the Job queues until one is online).
 * Without one the Issue is an ordinary assignment (`none`): nothing more is read and
 * nothing is written. It is `waiting` when a run of the execution repository that has
 * not started (`requested`, `waiting`, `pending`, `queued`) already has its title,
 * even if another Assignee would now be chosen; a waiting run keeps its runner label
 * and reads GitHub when it starts. Running runs never count. Then it asks for consent
 * (#721): when an Assignee other than the execution repository's owner has no Nibfin
 * comment `consent-<user id>` on the Issue yet, it adds `pause` and writes those
 * comments (`consent`); removing `pause` is the go-ahead. The check comes after the
 * waiting-run check so a queued run is never paused under itself. Otherwise `ready`.
 */
export async function planDispatch(
  scope: DispatchScope,
  repo: Repo,
  issue: number,
  target: DispatchTarget,
): Promise<DispatchPlan> {
  const name = `${repoName(repo)}#${issue}`;
  const ids = target.assignees.map((assignee) => assignee.id);
  const chosen = chooseAssignee(ids, await readRunners(scope.client, scope.runRepo));
  if (chosen === undefined) {
    scope.log(
      `${name}: no runner of the execution repository has the label nibfin-<id> ` +
        `of any Assignee (${ids.join(", ")}); an ordinary assignment, nothing dispatched`,
    );
    return { kind: "none" };
  }
  scope.log(
    chosen.online
      ? `${name}: Assignee ${chosen.assignee} has an online runner`
      : `${name}: Assignee ${chosen.assignee} has only offline runners; ` +
          "the Job queues until one is online",
  );
  const title = nibfinRunTitle(repo, issue, target.stage);
  const waiting = await findWaitingRun(scope, title);
  if (waiting !== undefined) {
    scope.log(`Not dispatching ${title}: run ${waiting.id} is waiting to start`);
    return { kind: "waiting", runId: waiting.id };
  }
  if (await askForConsent(scope, { ...repo, number: issue }, target.assignees)) {
    return { kind: "consent" };
  }
  return { kind: "ready", assignee: chosen.assignee };
}

/** Dispatches `target`'s stage for the Issue to `assignee`, as `planDispatch` chose. */
export async function dispatchPlanned(
  scope: DispatchScope,
  repo: Repo,
  issue: number,
  target: DispatchTarget,
  assignee: number,
): Promise<void> {
  await dispatch(scope, nibfinRunTitle(repo, issue, target.stage), {
    stage: target.stage,
    repo: repoName(repo),
    issue: String(issue),
    reason: target.reason ?? "",
    assignee: String(assignee),
  });
}

/**
 * Dispatches the stage of `route` for the Issue to one of its Assignees (#739): it
 * plans the dispatch (`planDispatch`) and dispatches only when the plan is `ready`.
 * Returns whether it dispatched.
 */
export async function dispatchStage(
  scope: DispatchScope,
  repo: Repo,
  issue: number,
  route: IssueRoute,
): Promise<boolean> {
  const plan = await planDispatch(scope, repo, issue, route);
  if (plan.kind !== "ready") {
    return false;
  }
  await dispatchPlanned(scope, repo, issue, route, plan.assignee);
  return true;
}

/**
 * The repair stage's dispatcher for the Issue (#778): plans and dispatches the
 * `repair` stage to one of `assignees`, and finds a repair run of the Issue that has
 * not started.
 */
export function repairDispatcher(
  scope: DispatchScope,
  repo: Repo,
  issue: number,
  assignees: readonly Actor[],
): RepairDispatcher {
  const target: DispatchTarget = { stage: "repair", reason: null, assignees };
  return {
    plan: () => planDispatch(scope, repo, issue, target),
    dispatch: (assignee) => dispatchPlanned(scope, repo, issue, target, assignee),
    waitingRun: async () =>
      (await findWaitingRun(scope, nibfinRunTitle(repo, issue, "repair")))?.id,
  };
}
