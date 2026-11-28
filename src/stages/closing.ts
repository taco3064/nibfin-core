import {
  type CdState,
  closeDelivered,
  deriveStage,
  findMarkedComment,
  freshReads,
  type IssueSnapshot,
  nibfinLabels,
  type PullRequestState,
  readCommentVersions,
  readCommitsAhead,
  readForcePushedHeads,
  readIssueSnapshot,
  readPullRequestCommits,
  readRequiredCheckResults,
  readRequiredChecks,
  type RequiredCheck,
  type RequiredCheckResult,
  type Stage,
  upsertMarkedComment,
} from "../github/index.ts";
import { issueOf } from "./agent.ts";
import { describeStage, reviewCommentKey } from "./deliver-eligibility.ts";
import { type NextAction, noNextAction } from "./next.ts";
import {
  deliveredCommentKey,
  issueName,
  pullTarget,
  type ReviewScope,
} from "./review-scope.ts";
import { wakeDownstream } from "./wake.ts";

/**
 * Whether this closed Issue counts as delivered: it carries `delivered`, whoever
 * closed it, Nibfin's own close or a person delivering by hand. Downstream Issues
 * judge an upstream resolved by Closed + `delivered` alone (R4.11), so only the wake
 * remains: the finish stage's wake-only redo and route rule 5. The caller checks
 * that the Issue is closed.
 */
export function closedAsDelivered(snapshot: IssueSnapshot): boolean {
  return snapshot.issue.labels.includes(nibfinLabels.delivered);
}

/** Required checks per base branch and their results per commit, read once each. */
class CiReader {
  readonly #scope: ReviewScope;
  readonly #checks = new Map<string, Promise<RequiredCheck[]>>();
  readonly #results = new Map<string, Promise<RequiredCheckResult[]>>();

  constructor(scope: ReviewScope) {
    this.#scope = scope;
  }

  results(base: string, sha: string): Promise<RequiredCheckResult[]> {
    const { client, context } = this.#scope;
    const key = `${base}\u0000${sha}`;
    let known = this.#results.get(key);
    if (known === undefined) {
      let checks = this.#checks.get(base);
      if (checks === undefined) {
        checks = readRequiredChecks(client, context.repo, base);
        this.#checks.set(base, checks);
      }
      known = checks.then((required) =>
        readRequiredCheckResults(client, context.repo, required, sha),
      );
      this.#results.set(key, known);
    }
    return known;
  }
}

const cdFixHead = /-cd-\d+$/;

function pullLine(pull: PullRequestState): string {
  const branches = `\`${pull.headRef}\` → \`${pull.baseRef}\``;
  const where = `[#${pull.number}](${pull.url}) ${branches}`;
  if (pull.merged) {
    return `- ${where}: merged as \`${pull.mergeCommitSha ?? "(unknown)"}\``;
  }
  return pull.state === "open"
    ? `- ${where}: open`
    : `- ${where}: closed without merging`;
}

function ciLines(pull: PullRequestState, results: RequiredCheckResult[]): string[] {
  const at = `#${pull.number} at \`${pull.headSha}\``;
  if (results.length === 0) {
    return [`- ${at}: no required checks`];
  }
  return results.map(
    (result) => `- ${at}: ${result.context}: ${result.state} (${result.url ?? "no URL"})`,
  );
}

function cdLines(pull: PullRequestState): string[] {
  const at = `#${pull.number} merge \`${pull.mergeCommitSha ?? "(unknown)"}\``;
  const runs = pull.cd?.runs ?? [];
  if (runs.length === 0) {
    return [`- ${at}: no CD runs`];
  }
  return runs.map(
    (run) =>
      `- ${at}: ${run.name} (\`${run.path}\`): ${String(run.conclusion)} ` +
      `(${run.url})`,
  );
}

/** The CD of a newer base head that passed for the Issue's red merge (#772). */
function passedOn(snapshot: IssueSnapshot): CdState | undefined {
  const stage = deriveStage(snapshot);
  return stage.stage === "done" ? stage.passedOn : undefined;
}

function passedOnLines(snapshot: IssueSnapshot): string[] {
  const head = passedOn(snapshot);
  if (head === undefined) {
    return [];
  }
  const base = snapshot.branches.current.pullRequests.find((pull) => pull.merged)!;
  return [
    `- CD passed on newer \`${base.baseRef}\` \`${head.mergeCommitSha}\`:`,
    ...head.runs.map(
      (run) =>
        `  - ${run.name} (\`${run.path}\`): ${String(run.conclusion)} (${run.url})`,
    ),
  ];
}

/**
 * Every commit a pull request has carried: its current commits and head, and the
 * commits of each head it had right before a force push (a rebase). A head GitHub no
 * longer has is logged and left out.
 */
async function pullRequestCommits(scope: ReviewScope, pull: PullRequestState) {
  const { client, context, deps } = scope;
  const commits = await readPullRequestCommits(client, context.repo, pull.number);
  const all = new Set([...commits, pull.headSha]);
  for (const before of await readForcePushedHeads(client, context.repo, pull.number)) {
    const ahead = await readCommitsAhead(client, context.repo, pull.baseRef, before);
    if (ahead === undefined) {
      deps.log(`#${pull.number}: the force-pushed head ${before} is gone; not counted`);
    }
    for (const sha of ahead ?? []) {
      all.add(sha);
    }
  }
  return all;
}

/**
 * Commits of the Issue's pull requests with a failed required check, counted once,
 * including heads a force push replaced.
 */
async function ciFixRounds(scope: ReviewScope, ci: CiReader, pulls: PullRequestState[]) {
  const failed = new Set<string>();
  for (const pull of pulls) {
    for (const sha of await pullRequestCommits(scope, pull)) {
      const results = await ci.results(pull.baseRef, sha);
      if (results.some((result) => result.state === "failed")) {
        failed.add(sha);
      }
    }
  }
  return failed.size;
}

/** Versions of the marked `review` comment on each pull request, summed. */
async function reviewRounds(scope: ReviewScope, pulls: PullRequestState[]) {
  let rounds = 0;
  for (const pull of pulls) {
    const target = pullTarget(scope, pull.number);
    const key = reviewCommentKey;
    const comment = await findMarkedComment(scope.client, target, key, "pull-request");
    if (comment !== undefined) {
      rounds += await readCommentVersions(scope.client, scope.context.repo, comment.id);
    }
  }
  return rounds;
}

/**
 * The closing comment, built only from GitHub data: every pull request of the
 * Issue's branches with its merge commit, the required checks of each merged head,
 * the CD runs of each merge (and of the newer base head that passed for a red merge,
 * #772), and the fix and review counts.
 */
export async function closingComment(
  scope: ReviewScope,
  snapshot: IssueSnapshot,
): Promise<string> {
  const pulls = snapshot.pullRequests.toSorted((a, b) => a.number - b.number);
  const merged = pulls.filter((pull) => pull.merged);
  const ci = new CiReader(scope);
  const ciSection: string[] = [];
  for (const pull of merged) {
    ciSection.push(...ciLines(pull, await ci.results(pull.baseRef, pull.headSha)));
  }
  const cdFixes = pulls.filter((pull) => cdFixHead.test(pull.headRef)).length;
  const counts = [
    `- CD-fix pull requests: ${cdFixes}`,
    `- CI-fix rounds: ${await ciFixRounds(scope, ci, pulls)}`,
    `- Review rounds: ${await reviewRounds(scope, pulls)}`,
  ];
  return [
    "Delivered: the merged work passed CD.",
    "",
    "### Pull requests",
    "",
    ...pulls.map(pullLine),
    "",
    "### CI (required checks of each merged head)",
    "",
    ...ciSection,
    "",
    "### CD",
    "",
    ...merged.flatMap(cdLines),
    ...passedOnLines(snapshot),
    "",
    "### Counts",
    "",
    ...counts,
  ].join("\n");
}

/**
 * The CD runs of every merged pull request, and of the newer base head the Issue
 * passed on, with their conclusions.
 */
function cdRecord(snapshot: IssueSnapshot): string {
  const runs = snapshot.pullRequests.flatMap((pull) =>
    (pull.cd?.runs ?? []).map((run) => `${pull.number}:${run.id}:${run.conclusion}`),
  );
  const head = passedOn(snapshot);
  const newer =
    head === undefined
      ? []
      : head.runs.map((run) => `${head.mergeCommitSha}:${run.id}:${run.conclusion}`);
  return [...runs, ...newer].toSorted().join(",");
}

/**
 * At `done`: writes the closing comment, then re-reads GitHub and closes only when
 * the Issue is still `done` with the same CD runs and conclusions (a late run is
 * waited for), then adds `delivered`, closes the Issue and names the downstream
 * Issues to wake.
 */
export async function closeIssue(
  scope: ReviewScope,
  snapshot: IssueSnapshot,
): Promise<NextAction> {
  const { client, context, deps } = scope;
  const issue = issueOf(context);
  const body = await closingComment(scope, snapshot);
  const comment = await upsertMarkedComment(client, issue, deliveredCommentKey, body);
  const after = await readIssueSnapshot(client, context.repo, context.issue);
  const stage = deriveStage(after);
  const changed = cdRecord(after) !== cdRecord(snapshot);
  if (stage.stage !== "done" || changed) {
    deps.log(
      `Not closing ${issueName(scope)}: it is now ${describeStage(stage)} or its CD ` +
        "runs changed since the closing comment",
    );
    return noNextAction;
  }
  await closeDelivered(client, issue);
  deps.log(`Closed ${issueName(scope)} as delivered: ${comment.url}`);
  return { ...noNextAction, wake: await wakeDownstream(scope) };
}

/** An `awaiting-cd` reason, with the Issue it waits on when known (#772). */
function waitReason(stage: Extract<Stage, { stage: "awaiting-cd" }>): string {
  return stage.waitingOn === undefined
    ? stage.reason
    : `${stage.reason}, waiting on #${stage.waitingOn}`;
}

/** The stages of an Issue whose pull request merged. */
export type MergedStage = Extract<Stage, { stage: "awaiting-cd" | "cd-failed" | "done" }>;

/**
 * The one rule for an Issue whose pull request merged (Proposal R3.30, R3.31,
 * R4.11): `awaiting-cd` waits with no next action (a CD completion wakes it),
 * `cd-failed` asks for the CD-failure fix, and `done` writes the closing comment,
 * closes the Issue as delivered and names the downstream Issues to wake.
 */
export async function settleMerged(
  scope: ReviewScope,
  snapshot: IssueSnapshot,
  stage: MergedStage,
): Promise<NextAction> {
  switch (stage.stage) {
    case "awaiting-cd":
      scope.deps.log(`${issueName(scope)} is waiting for CD (${waitReason(stage)})`);
      return noNextAction;
    case "cd-failed":
      scope.deps.log(`${issueName(scope)}: CD failed; requesting a CD-failure fix`);
      return { stage: "deliver", reason: "cd-failure" };
    case "done":
      return closeIssue(scope, snapshot);
  }
}

/**
 * Right after a merge that left the base where it was (#771): no push follows, so
 * this run goes on with the Issue as GitHub shows it now (`settleMerged`); any other
 * stage (`pause`, a manual close, …) stops with no next action.
 */
export async function continueMerged(scope: ReviewScope): Promise<NextAction> {
  const { client, context, deps } = scope;
  freshReads(client);
  const snapshot = await readIssueSnapshot(client, context.repo, context.issue);
  const stage = deriveStage(snapshot);
  switch (stage.stage) {
    case "awaiting-cd":
    case "cd-failed":
    case "done":
      return settleMerged(scope, snapshot, stage);
  }
  deps.log(`${issueName(scope)} is ${describeStage(stage)} after the merge; stopping`);
  return noNextAction;
}
