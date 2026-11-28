// The option a Collaborator chose on a repair record (#779, Proposal R4.51, R4.52):
// reading the decision comment and storing the choice in Nibfin's `choice` comment
// until the next Shape run applies it. See "Chosen option" in README.md.
import {
  type ActingClient,
  findMarkedComment,
  hasWritePermission,
  type IssueRef,
  listIssueComments,
  readIssueComment,
  upsertMarkedComment,
} from "../github/index.ts";
import {
  parseDecision,
  parseOptions,
  parseRepairRecord,
  recordReason,
  repairCommentKey,
} from "./repair-record.ts";

/** The comment key of the stored choice (`<!-- nibfin:choice -->`). */
export const choiceCommentKey = "choice";

/**
 * How far applying a stored choice got: `chosen` (stored, nothing applied),
 * `applying` (the Issue change started), `applied` (done) or `dropped` (not applied).
 */
export type ChoiceStatus = "chosen" | "applying" | "applied" | "dropped";

/** One decision on an options record. */
export interface Choice {
  /** The options record's `for`. */
  for: string;
  option: number;
  /** The decision comment's id and URL. */
  comment: number;
  commentUrl: string;
  /** The decision comment's author. */
  author: string;
  /** The chosen option's lines from the record. */
  optionText: string;
  /** The record's Reason line. */
  reason: string;
}

/**
 * What a reader sees: `new` for a live decision not stored yet, otherwise the stored
 * choice's status; `null` when there is no choice.
 */
export interface ChoiceState {
  status: "new" | ChoiceStatus;
  choice: Choice;
}

const statusText: Record<ChoiceStatus, string> = {
  chosen: "chosen; the next Shape run applies it to the Issue, then shapes it.",
  applying: "being applied to the Issue.",
  applied: "applied.",
  dropped: "not applied.",
};

const stateLine = new RegExp(
  "^<!-- nibfin:choice-state for=([0-9a-f]{16}) option=([1-9][0-9]*) " +
    "comment=([1-9][0-9]*) status=(chosen|applying|applied|dropped) -->$",
);
const chosenLine = new RegExp(
  "^Option [1-9][0-9]* was chosen by `([^`\\n]+)` in \\[this comment\\]" +
    "\\((\\S+)\\) on the repair record\\.$",
  "m",
);
const reasonLine = /^- Reason of the stop: (.*)$/m;
const optionHeading = "\n### Chosen option\n\n";

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The `choice` comment body (without its marker line): the state line, who chose
 * which option where, the record's Reason, the status and `details` (one line each),
 * then the chosen option's text last.
 */
export function formatChoice(
  choice: Choice,
  status: ChoiceStatus,
  details: readonly string[] = [],
): string {
  return [
    `<!-- nibfin:choice-state for=${choice.for} option=${choice.option} ` +
      `comment=${choice.comment} status=${status} -->`,
    `Option ${choice.option} was chosen by \`${choice.author}\` in ` +
      `[this comment](${choice.commentUrl}) on the repair record.`,
    "",
    `- Reason of the stop: ${oneLine(choice.reason)}`,
    `- Status: ${statusText[status]}`,
    ...details.map((detail) => `- ${oneLine(detail)}`),
    "",
    "### Chosen option",
    "",
    choice.optionText.trim(),
  ].join("\n");
}

/**
 * The stored choice of a `choice` comment body (marker line optional); `undefined`
 * when a part `formatChoice` writes is missing.
 */
export function parseChoice(
  body: string,
): (Choice & { status: ChoiceStatus }) | undefined {
  const lines = body.split("\n");
  const first = lines[0] === "<!-- nibfin:choice -->" ? lines[1] : lines[0];
  const state = stateLine.exec(first ?? "");
  const chosen = chosenLine.exec(body);
  const reason = reasonLine.exec(body);
  const at = body.indexOf(optionHeading);
  if (state === null || chosen === null || reason === null || at === -1) {
    return undefined;
  }
  return {
    for: state[1],
    option: Number(state[2]),
    comment: Number(state[3]),
    status: state[4] as ChoiceStatus,
    author: chosen[1],
    commentUrl: chosen[2],
    reason: reason[1],
    optionText: body.slice(at + optionHeading.length).trim(),
  };
}

/**
 * The live decision on Nibfin's options record (R4.51): among the comments created
 * after the record's last update, newest first, the first that `parseDecision` reads
 * as an option the record lists and whose author has write access to the Issue's
 * repository (one permission read per login). `null` without an options record or
 * such a comment (R4.52).
 */
export async function readLiveDecision(
  client: ActingClient,
  issue: IssueRef,
): Promise<Choice | null> {
  const record = await findMarkedComment(client, issue, repairCommentKey);
  const state = record === undefined ? undefined : parseRepairRecord(record.body);
  if (record === undefined || state?.action !== "options") {
    return null;
  }
  const options = parseOptions(record.body);
  const { updatedAt } = await readIssueComment(client, issue, record.id);
  const since = Date.parse(updatedAt);
  const comments = (await listIssueComments(client, issue))
    .filter((comment) => Date.parse(comment.createdAt) > since)
    .reverse();
  const repo = { owner: issue.owner, repo: issue.repo };
  const writers = new Map<string, boolean>();
  for (const comment of comments) {
    const number = parseDecision(comment.body);
    const option = options.find((candidate) => candidate.number === number);
    if (option === undefined || comment.login === null) {
      continue;
    }
    let writer = writers.get(comment.login);
    if (writer === undefined) {
      writer = await hasWritePermission(client, repo, comment.login);
      writers.set(comment.login, writer);
    }
    if (writer) {
      return {
        for: state.for,
        option: option.number,
        comment: comment.id,
        commentUrl: comment.url,
        author: comment.login,
        optionText: option.text,
        reason: recordReason(record.body) ?? "",
      };
    }
  }
  return null;
}

const sameDecision = (a: Choice, b: Choice) =>
  a.for === b.for && a.option === b.option && a.comment === b.comment;

/**
 * The Issue's choice: one decision per options record, so a stored choice for the
 * live record that is `applying`, `applied` or `dropped` stands; otherwise a live
 * decision is `new`, or `chosen` when it is the one stored. Without a live decision,
 * a stored `chosen` or `applying` choice stands (it was saved before a later stop
 * replaced its record). Anything else is `null`.
 */
export async function readChoice(
  client: ActingClient,
  issue: IssueRef,
): Promise<ChoiceState | null> {
  const comment = await findMarkedComment(client, issue, choiceCommentKey);
  const stored = comment === undefined ? undefined : parseChoice(comment.body);
  const live = await readLiveDecision(client, issue);
  if (live !== null) {
    if (stored !== undefined && stored.for === live.for && stored.status !== "chosen") {
      return { status: stored.status, choice: stored };
    }
    if (stored !== undefined && sameDecision(stored, live)) {
      return { status: "chosen", choice: stored };
    }
    return { status: "new", choice: live };
  }
  if (stored?.status === "chosen" || stored?.status === "applying") {
    return { status: stored.status, choice: stored };
  }
  return null;
}

/** Whether the choice still has to be applied: `new`, `chosen` or `applying`. */
export function pendingChoice(state: ChoiceState | null): state is ChoiceState {
  return (
    state !== null &&
    (state.status === "new" || state.status === "chosen" || state.status === "applying")
  );
}

/** Writes Nibfin's `choice` comment, confirmed by `upsertMarkedComment`'s read-back. */
export async function saveChoice(
  client: ActingClient,
  issue: IssueRef,
  choice: Choice,
  status: ChoiceStatus,
  details: readonly string[] = [],
): Promise<void> {
  const body = formatChoice(choice, status, details);
  await upsertMarkedComment(client, issue, choiceCommentKey, body);
}

/**
 * Before the repair stage replaces an options record for a later stop: a live
 * decision not stored yet is saved as `chosen`, so the next Shape run still applies
 * it. Writes nothing otherwise.
 */
export async function keepChoice(client: ActingClient, issue: IssueRef): Promise<void> {
  const state = await readChoice(client, issue);
  if (state?.status === "new") {
    await saveChoice(client, issue, state.choice, "chosen");
  }
}
