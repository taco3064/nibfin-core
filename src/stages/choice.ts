// A Collaborator's decision on a repair record (Proposal R4.51, R4.52): reading the
// decision comment and storing it in Nibfin's `choice` comment until the next Shape
// run applies it. See "Chosen option" in README.md.
import {
  type ActingClient,
  findMarkedComment,
  hasWritePermission,
  type IssueRef,
  listIssueComments,
  nibfinLabels,
  readIssueComment,
  readLastUnlabeled,
  upsertMarkedComment,
} from "../github/index.ts";
import {
  isNibfinComment,
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

/**
 * One decision on an options record: an option (the Dashboard's marked comment or a
 * body that is only a listed option number) or the Collaborator's own words.
 */
export interface Choice {
  /** The options record's `for`. */
  for: string;
  /** The option the decision names; absent for a decision in the person's own words. */
  option?: number;
  /** The named option's lines from the record; present exactly with `option`. */
  optionText?: string;
  /** Without `option`: the record's options, as suggestions, when it lists any. */
  options?: string;
  /** The decision comment's body as written (line endings `\n`, trimmed). */
  text: string;
  /** The decision comment's id and URL. */
  comment: number;
  commentUrl: string;
  /** The decision comment's author. */
  author: string;
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
const partlyAppliedText =
  "the Issue body and Blocked by changes were applied; the parts under Not applied " +
  "are for a person to do.";

const stateLine = new RegExp(
  "^<!-- nibfin:choice-state for=([0-9a-f]{16})(?: option=([1-9][0-9]*))? " +
    "comment=([1-9][0-9]*) status=(chosen|applying|applied|dropped) -->$",
);
const chosenLine = new RegExp(
  "^Option [1-9][0-9]* was chosen by `([^`\\n]+)` in \\[this comment\\]" +
    "\\((\\S+)\\) on the repair record\\.$",
  "m",
);
const ownWordsLine = new RegExp(
  "^`([^`\\n]+)` decided in their own words in \\[this comment\\]" +
    "\\((\\S+)\\) on the repair record\\.$",
  "m",
);
const reasonLine = /^- Reason of the stop: (.*)$/m;
const optionHeading = "\n### Chosen option\n\n";
const suggestedHeading = "\n### Suggested options\n\n";
const decisionHeading = "\n### Decision\n\n";

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** Line endings as GitHub keeps them, without surrounding blank space. */
const normalize = (text: string) => text.replace(/\r\n?/g, "\n").trim();

/**
 * The `choice` comment body (without its marker line): the state line, who decided
 * (which option, or in their own words) where, the record's Reason, the status,
 * `details` and one `Not applied:` line per `notApplied` part (one line each), then
 * the chosen option's text (or, for own words, the suggested options when there are
 * any), then the decision's text last. Option and options texts never hold a `### `
 * line (`parseOptions` ends at one), so the first `### Decision` heading is the
 * boundary.
 */
export function formatChoice(
  choice: Choice,
  status: ChoiceStatus,
  details: readonly string[] = [],
  notApplied: readonly string[] = [],
): string {
  const option = choice.option === undefined ? "" : ` option=${choice.option}`;
  const where = `[this comment](${choice.commentUrl}) on the repair record.`;
  const who =
    choice.option === undefined
      ? `\`${choice.author}\` decided in their own words in ${where}`
      : `Option ${choice.option} was chosen by \`${choice.author}\` in ${where}`;
  const partly = status === "applied" && notApplied.length > 0;
  const section =
    choice.optionText !== undefined
      ? ["### Chosen option", "", choice.optionText.trim(), ""]
      : choice.options === undefined
        ? []
        : ["### Suggested options", "", choice.options.trim(), ""];
  return [
    `<!-- nibfin:choice-state for=${choice.for}${option} ` +
      `comment=${choice.comment} status=${status} -->`,
    who,
    "",
    `- Reason of the stop: ${oneLine(choice.reason)}`,
    `- Status: ${partly ? partlyAppliedText : statusText[status]}`,
    ...details.map((detail) => `- ${oneLine(detail)}`),
    ...notApplied.map((part) => `- Not applied: ${oneLine(part)}`),
    "",
    ...section,
    "### Decision",
    "",
    choice.text,
  ].join("\n");
}

/** The text of the section after `heading` in `head`, or `undefined` without one. */
function section(head: string, heading: string): string | undefined {
  const at = head.indexOf(heading);
  return at === -1 ? undefined : head.slice(at + heading.length).trim();
}

/**
 * The stored choice of a `choice` comment body (marker line optional); `undefined`
 * when a part `formatChoice` writes is missing. The header lines are read only before
 * the first section heading, so a decision's own text cannot fake them. A body
 * without `### Decision` (written before own-words decisions existed) is an option
 * choice with an empty `text`.
 */
export function parseChoice(
  body: string,
): (Choice & { status: ChoiceStatus }) | undefined {
  const lines = body.split("\n");
  const first = lines[0] === "<!-- nibfin:choice -->" ? lines[1] : lines[0];
  const state = stateLine.exec(first ?? "");
  const decisionAt = body.indexOf(decisionHeading);
  const head = decisionAt === -1 ? body : body.slice(0, decisionAt);
  const text = decisionAt === -1 ? "" : body.slice(decisionAt + decisionHeading.length);
  const headingAt = head.indexOf("\n### ");
  const header = headingAt === -1 ? head : head.slice(0, headingAt);
  const reason = reasonLine.exec(header);
  if (state === null || reason === null) {
    return undefined;
  }
  const base = {
    for: state[1],
    comment: Number(state[3]),
    status: state[4] as ChoiceStatus,
    reason: reason[1],
    text: text.trim(),
  };
  if (state[2] !== undefined) {
    const chosen = chosenLine.exec(header);
    const optionText = section(head, optionHeading);
    if (chosen === null || optionText === undefined) {
      return undefined;
    }
    return {
      ...base,
      option: Number(state[2]),
      optionText,
      author: chosen[1],
      commentUrl: chosen[2],
    };
  }
  const own = ownWordsLine.exec(header);
  if (own === null || decisionAt === -1) {
    return undefined;
  }
  const options = section(head, suggestedHeading);
  return {
    ...base,
    ...(options === undefined ? {} : { options }),
    author: own[1],
    commentUrl: own[2],
  };
}

/**
 * The live decision on Nibfin's options record (R4.51): among the comments created
 * after the record's last update and, once `pending` was removed after that update,
 * at or before that removal, newest first, the first whose author has write access
 * to the Issue's repository (one permission read per login). Comments without an
 * author, empty ones and Nibfin's own marked comments are skipped; a non-writer's
 * comment never ends the search. The Dashboard's marked comment or a body that is
 * only a number the record lists maps to that option; any other body is a decision
 * in the person's own words, never read as an option, carrying the record's options
 * as suggestions. `null` without an options record or such a comment (R4.52). The
 * upper bound keeps a comment written after `pending` was removed without a decision
 * from turning into one later.
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
  const removed = await readLastUnlabeled(client, issue, nibfinLabels.pending);
  const removedAt = removed === null ? Number.NaN : Date.parse(removed);
  const until = removedAt > since ? removedAt : Number.POSITIVE_INFINITY;
  const comments = (await listIssueComments(client, issue))
    .filter((comment) => {
      const created = Date.parse(comment.createdAt);
      return created > since && created <= until;
    })
    .reverse();
  const repo = { owner: issue.owner, repo: issue.repo };
  const writers = new Map<string, boolean>();
  for (const comment of comments) {
    const text = normalize(comment.body);
    if (comment.login === null || text === "" || isNibfinComment(text)) {
      continue;
    }
    let writer = writers.get(comment.login);
    if (writer === undefined) {
      writer = await hasWritePermission(client, repo, comment.login);
      writers.set(comment.login, writer);
    }
    if (!writer) {
      continue;
    }
    const decision = {
      for: state.for,
      text,
      comment: comment.id,
      commentUrl: comment.url,
      author: comment.login,
      reason: recordReason(record.body) ?? "",
    };
    const number = parseDecision(text);
    const option = options.find((candidate) => candidate.number === number);
    if (option !== undefined) {
      return { ...decision, option: option.number, optionText: option.text };
    }
    if (options.length === 0) {
      return decision;
    }
    return { ...decision, options: options.map((item) => item.text).join("\n") };
  }
  return null;
}

/**
 * Whether two choices are the same decision: the same record, option and comment,
 * and the same text, so an edit of the decision comment is a new decision.
 */
export const sameDecision = (a: Choice, b: Choice) =>
  a.for === b.for &&
  a.option === b.option &&
  a.comment === b.comment &&
  a.text === b.text;

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
  notApplied: readonly string[] = [],
): Promise<void> {
  const body = formatChoice(choice, status, details, notApplied);
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
