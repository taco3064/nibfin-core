import {
  closeDelivered,
  deriveStage,
  findMarkedComment,
  type IssueSnapshot,
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
    const comment = await findMarkedComment(scope.client, target, reviewCommentKey);
    if (comment !== undefined) {
      rounds += await readCommentVersions(scope.client, scope.context.repo, comment.id);
    }
  }
  return rounds;
}

/**
 * The closing comment, built only from GitHub data: every pull request of the
 * Issue's branches with its merge commit, the required checks of each merged head,
 * the CD runs of each merge, and the fix and review counts.
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
    "",
    "### Counts",
    "",
    ...counts,
  ].join("\n");
}

/** The CD runs of every merged pull request, with their conclusions. */
function cdRecord(snapshot: IssueSnapshot): string {
  const runs = snapshot.pullRequests.flatMap((pull) =>
    (pull.cd?.runs ?? []).map((run) => `${pull.number}:${run.id}:${run.conclusion}`),
  );
  return runs.toSorted().join(",");
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
  if (stage.stage !== "done" || cdRecord(after) !== cdRecord(snapshot)) {
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
