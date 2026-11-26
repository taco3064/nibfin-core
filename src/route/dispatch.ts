import {
  type ActingClient,
  dispatchWorkflow,
  nibfinRunTitle,
  readNotStartedRuns,
  readRunners,
  type Repo,
  type RunnerLabels,
  runnerLabel,
} from "../github/index.ts";
import { askForConsent } from "./consent.ts";
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

/** Dispatches a route run for the Issue; never deduplicated, so no wake is lost. */
export async function dispatchRoute(
  scope: DispatchScope,
  repo: Repo,
  issue: number,
): Promise<void> {
  const inputs = { stage: "route", repo: repoName(repo), issue: String(issue) };
  await dispatch(scope, nibfinRunTitle(repo, issue, "route"), inputs);
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

/**
 * Dispatches the stage of `route` for the Issue to one of its Assignees (#739): it
 * lists the execution repository's self-hosted runners and, in GitHub's Assignee
 * order, takes the first Assignee with an online runner labelled `nibfin-<user id>`
 * (case-insensitive, busy or not), else the first with any such runner (the Job
 * queues until one is online). Without one the Issue is an ordinary assignment:
 * nothing more is read and nothing is written. It also skips when a run of the
 * execution repository that has not started (`requested`, `waiting`, `pending`,
 * `queued`) already has its title, even if another Assignee would now be chosen; a
 * waiting run keeps its runner label and reads GitHub when it starts. Running runs
 * never count. Then, before dispatching, it asks for consent (#721):
 * when an Assignee other than the execution repository's owner has no Nibfin
 * comment `consent-<user id>` on the Issue yet, it adds `pause`, writes those
 * comments and dispatches nothing; removing `pause` is the go-ahead. The check comes
 * after the waiting-run skip so a queued run is never paused under itself.
 * Returns whether it dispatched.
 */
export async function dispatchStage(
  scope: DispatchScope,
  repo: Repo,
  issue: number,
  route: IssueRoute,
): Promise<boolean> {
  const name = `${repoName(repo)}#${issue}`;
  const ids = route.assignees.map((assignee) => assignee.id);
  const chosen = chooseAssignee(ids, await readRunners(scope.client, scope.runRepo));
  if (chosen === undefined) {
    scope.log(
      `${name}: no runner of the execution repository has the label nibfin-<id> ` +
        `of any Assignee (${ids.join(", ")}); an ordinary assignment, nothing dispatched`,
    );
    return false;
  }
  scope.log(
    chosen.online
      ? `${name}: Assignee ${chosen.assignee} has an online runner`
      : `${name}: Assignee ${chosen.assignee} has only offline runners; ` +
          "the Job queues until one is online",
  );
  const title = nibfinRunTitle(repo, issue, route.stage);
  const waiting = (await readNotStartedRuns(scope.client, scope.runRepo)).find(
    (run) => run.id !== scope.runId && run.title === title,
  );
  if (waiting !== undefined) {
    scope.log(`Not dispatching ${title}: run ${waiting.id} is waiting to start`);
    return false;
  }
  if (await askForConsent(scope, { ...repo, number: issue }, route.assignees)) {
    return false;
  }
  await dispatch(scope, title, {
    stage: route.stage,
    repo: repoName(repo),
    issue: String(issue),
    reason: route.reason ?? "",
    assignee: String(chosen.assignee),
  });
  return true;
}
