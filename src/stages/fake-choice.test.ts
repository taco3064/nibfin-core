// Test support for a decision on a repair record: an options repair record,
// decision comments and collaborator permissions on the fake Issue. It holds no tests
// of its own.
import { upsertMarkedComment } from "../github/index.ts";
import { type FakeComment, type FakeIssues, seedComment } from "./fake-job.test.ts";
import { formatDecision, formatOptions, formatRepairRecord } from "./repair-record.ts";
import type { RepairOption } from "./repair-roles.ts";

export const issueRef = { owner: "acme", repo: "app", number: 1 };

/** The `for` of the options records these tests write. */
export const recordFor = "0123456789abcdef";

export const options: RepairOption[] = [
  {
    title: "Keep the widget",
    consequence: "The widget stays.\n2. not an option",
    issueChange: "Nothing changes.",
    recommended: false,
  },
  {
    title: "Drop the widget",
    consequence: "The widget goes; simpler.",
    issueChange: "The body asks for no widget.",
    recommended: true,
  },
];

/** The record body (no marker) of an options record for `forDigest`. */
export function optionsRecordBody(forDigest = recordFor): string {
  return formatRepairRecord(
    { for: forDigest, status: "waiting-for-choice", action: "options", handled: [] },
    {
      category: "E, product decision",
      reason: "The Issue leaves the widget open.",
      evidence: "code `STAGE_BLOCKED`",
      done: "Nothing; `pending` stays.",
      advice: "Reply with an option number or in your own words.",
      details: formatOptions(options),
    },
  );
}

/** Writes Nibfin's options record on the main Issue. */
export async function writeOptionsRecord(
  issues: FakeIssues,
  forDigest = recordFor,
): Promise<void> {
  const body = optionsRecordBody(forDigest);
  await upsertMarkedComment(issues.github.client, issueRef, "repair", body);
}

/**
 * A comment by user `userId` (login `user-<userId>`): a marked decision for a number,
 * otherwise `body` as written.
 */
export function decide(
  issues: FakeIssues,
  body: number | string,
  userId = 7,
): FakeComment {
  const text = typeof body === "number" ? formatDecision(body) : body;
  return seedComment(issues, issues.main, text, userId);
}

/** Routes `GET …/collaborators/user-<id>/permission`; absent ids answer 404. */
export function permissions(
  issues: FakeIssues,
  byUser: Record<number, string> = { 7: "write" },
): void {
  for (const [id, permission] of Object.entries(byUser)) {
    const path = `GET /repos/acme/app/collaborators/user-${id}/permission`;
    issues.github.routes.set(path, { data: { permission } });
  }
}

/** The URL of a comment on the main Issue. */
export const commentUrl = (comment: FakeComment) =>
  `https://github.com/acme/app/issues/1#issuecomment-${comment.id}`;
