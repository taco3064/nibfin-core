import {
  type DependencyIssue,
  deriveStage,
  GitHubError,
  readBlocking,
  readIssueSnapshot,
  type Stage,
} from "../github/index.ts";
import { issueOf } from "./agent.ts";
import type { WakeTarget } from "./next.ts";
import type { ReviewScope } from "./review-scope.ts";

function whyNot(stage: Extract<Stage, { stage: "ineligible" }>): string {
  if (stage.reason === "blocked") {
    const urls = stage.blockers.map((blocker) => blocker.url);
    return `blocked by ${urls.join(", ")}`;
  }
  return stage.reason;
}

/** The stage of one downstream Issue, or why it could not be read. */
async function downstreamStage(scope: ReviewScope, issue: DependencyIssue) {
  try {
    const repo = { owner: issue.owner, repo: issue.repo };
    const snapshot = await readIssueSnapshot(scope.client, repo, issue.number);
    return deriveStage(snapshot);
  } catch (error) {
    if (error instanceof GitHubError) {
      return { stage: "unreadable" as const, reason: error.message };
    }
    throw error;
  }
}

/**
 * The Issues this Issue blocks, in any repository, that are now at `shape` or a
 * delivery stage. Every other one is logged with its reason (still blocked with its
 * remaining blockers, `no-assignee`, `paused`, unreadable, …) and never woken.
 */
export async function wakeDownstream(scope: ReviewScope): Promise<WakeTarget[]> {
  const { client, deps } = scope;
  const downstream = await readBlocking(client, issueOf(scope.context));
  const wake: WakeTarget[] = [];
  for (const issue of downstream) {
    const name = `${issue.owner}/${issue.repo}#${issue.number}`;
    const stage = await downstreamStage(scope, issue);
    if (stage.stage === "unreadable") {
      deps.log(`Not waking ${name}: it cannot be read (${stage.reason})`);
    } else if (stage.stage === "ineligible") {
      deps.log(`Not waking ${name}: ${whyNot(stage)}`);
    } else {
      deps.log(`Waking ${name} (${stage.stage})`);
      wake.push({ repo: `${issue.owner}/${issue.repo}`, issue: issue.number });
    }
  }
  return wake;
}
