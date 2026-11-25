import {
  type Actor,
  findMarkedComment,
  GitHubError,
  type IssueRef,
  nibfinLabels,
  readRepoOwnerId,
  setLabels,
  upsertMarkedComment,
} from "../github/index.ts";
import type { DispatchScope } from "./dispatch.ts";

/** The key of Nibfin's comment that asked Assignee `id` for consent (#721). */
export function consentCommentKey(id: number): string {
  return `consent-${id}`;
}

/** The comment that asks Assignee `login` to read the Issue and remove `pause`. */
export function consentBody(login: string): string {
  return [
    `@${login}, you are an Assignee of this Issue, and Nibfin runs this Issue's ` +
      "stages on a runner of one of its Assignees.",
    "Nibfin has added `pause` and is waiting: read the Issue, then remove the " +
      "`pause` label to start.",
    "This is a consent step, not a security control: anyone who can edit labels " +
      "can remove `pause`.",
    "Nibfin asks each Assignee once.",
  ].join("\n\n");
}

/**
 * Asks the Assignees other than the execution repository's owner (its `owner.id`)
 * whom Nibfin has not asked on this Issue yet: adds `pause`, confirmed by the
 * read-back labels, then writes one marked comment `consent-<user id>` per such
 * Assignee in GitHub's order. Only Nibfin's own comments count as asked, so each
 * Assignee is asked once; removing `pause` is the go-ahead. Returns whether it
 * asked, in which case nothing may be dispatched.
 */
export async function askForConsent(
  scope: DispatchScope,
  issue: IssueRef,
  assignees: readonly Actor[],
): Promise<boolean> {
  const owner = await readRepoOwnerId(scope.client, scope.runRepo);
  const unasked: Actor[] = [];
  for (const assignee of assignees) {
    if (assignee.id === owner) {
      continue;
    }
    const key = consentCommentKey(assignee.id);
    if ((await findMarkedComment(scope.client, issue, key)) === undefined) {
      unasked.push(assignee);
    }
  }
  if (unasked.length === 0) {
    return false;
  }
  const labels = await setLabels(scope.client, issue, { add: [nibfinLabels.pause] });
  if (!labels.includes(nibfinLabels.pause)) {
    throw new GitHubError(
      "GITHUB_WRITE_UNCONFIRMED",
      "add pause",
      new Error("The read-back labels lack pause"),
    );
  }
  for (const assignee of unasked) {
    const key = consentCommentKey(assignee.id);
    await upsertMarkedComment(scope.client, issue, key, consentBody(assignee.login));
  }
  const ids = unasked.map((assignee) => assignee.id).join(", ");
  scope.log(
    `${issue.owner}/${issue.repo}#${issue.number}: added pause for the consent of ` +
      `Assignee(s) ${ids}; nothing dispatched`,
  );
  return true;
}
