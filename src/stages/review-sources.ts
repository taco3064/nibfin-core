import type { PullRequestState, RequiredCheckResult } from "../github/index.ts";
import type { DeliverSources } from "./deliver-prompts.ts";
import { fenced, type PromptSection } from "./prompt.ts";

/** What the reviewer reads about the pinned head of the pull request. */
export interface ReviewSources {
  /** The current Issue and its approved Shape, read for this run. */
  requirements: DeliverSources;
  pullRequest: PullRequestState;
  /** The pinned head: the only head the reviewer may review. */
  head: string;
  base: string;
  diff: string;
  /** One result per required check of the base, for the pinned head. */
  results: RequiredCheckResult[];
}

function ciText(sources: ReviewSources): string {
  if (sources.results.length === 0) {
    return `\`${sources.base}\` requires no checks.`;
  }
  const lines = sources.results.map(
    (result) => `- ${result.context}: ${result.state} (${result.url ?? "no URL"})`,
  );
  return [
    `Required checks of \`${sources.base}\` on ${sources.head}:`,
    "",
    ...lines,
  ].join("\n");
}

function authorityText(base: string): string {
  return (
    "Read the product authority the repository designates as it is on the base " +
    `branch: \`git show refs/remotes/origin/${base}:<path>\`. The pull request may ` +
    "change files in the workspace, including that document; the base version is " +
    "the authority."
  );
}

/** The prompt sections of the reviewer: requirements, pinned head, diff and CI. */
export function reviewSections(sources: ReviewSources): PromptSection[] {
  const { requirements } = sources;
  const body = requirements.body.trim() === "" ? "(no description)" : requirements.body;
  return [
    {
      title: "Task",
      body:
        `Review pull request ${sources.pullRequest.url} at the pinned head ` +
        `${sources.head} against the current Issue and its approved Shape.`,
    },
    {
      title: "Current Issue",
      body: `URL: ${requirements.issueUrl}\nTitle: ${requirements.title}\n\n${body}`,
    },
    { title: "Approved Shape", body: requirements.shape },
    { title: "Product authority", body: authorityText(sources.base) },
    {
      title: "Pinned head",
      body:
        `The workspace has ${sources.head} checked out (detached). Review only this ` +
        "head and return it as `reviewedHead`.",
    },
    {
      title: `Pull request diff against origin/${sources.base}`,
      body: fenced(sources.diff, "diff"),
    },
    { title: "CI results for the pinned head", body: ciText(sources) },
  ];
}
