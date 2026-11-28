// The Shape stage applies a Collaborator's decision on a repair record (an option or
// their own words) before it shapes (Proposal R4.51). See "Chosen option" in
// README.md.
import {
  addBlockedBy,
  deriveStage,
  freshReads,
  type IssueRef,
  type IssueSnapshot,
  nibfinLabels,
  readIssueId,
  readIssueSnapshot,
  setLabels,
  updateIssueBody,
} from "../github/index.ts";
import { runStageAgent, type StageJob } from "./agent.ts";
import {
  type Choice,
  type ChoiceState,
  pendingChoice,
  readChoice,
  sameDecision,
  saveChoice,
} from "./choice.ts";
import { describeStage } from "./deliver-eligibility.ts";
import { StageError } from "./errors.ts";
import { redactToken } from "./git.ts";
import { fenced, type PromptSection } from "./prompt.ts";
import { parseIssueUrl } from "./repair-roles.ts";
import { blockShape } from "./shape-publish.ts";
import { parseChoiceResult, shapeChoiceRole } from "./shape-roles.ts";
import {
  issueTextChanged,
  readShapeSources,
  type ShapeSources,
  sourceSections,
} from "./shape-sources.ts";
import { isDeliveryStage, unconfirmed } from "./shape-wrong.ts";

const choiceTask =
  "A Collaborator decided on Nibfin's repair record of this Issue (Proposal R4.51); " +
  "the decision is below, as they wrote it. The record's options are suggestions " +
  "only. Follow the skill's \"A person's decision on a repair record\". Return the " +
  "Issue change the decision asks for: the complete new Issue body (or `null` when " +
  "the body stays as it is) and any `Blocked by` Issue URLs to add. List in " +
  "`notApplied` every part of the decision that is not a change to the body or " +
  "Blocked by (for example a label, a CI rerun or closing the Issue); Core does not " +
  "perform them and posts them for a person. Keep everything the decision does not " +
  "change, and keep every `Origin:` line of the current body. Core writes the " +
  "change; do not shape the Issue.";

/** How logs and errors name a decision: its option, or the comment it is in. */
const describeChoice = (choice: Choice) =>
  choice.option === undefined
    ? `the decision in ${choice.commentUrl}`
    : `option ${choice.option} (chosen in ${choice.commentUrl})`;

function choiceSections(choice: Choice, sources: ShapeSources): PromptSection[] {
  const named =
    choice.optionText !== undefined
      ? ["", `It names option ${choice.option}:`, "", choice.optionText]
      : choice.options === undefined
        ? []
        : ["", "The record's options, suggestions only:", "", choice.options];
  return [
    { title: "Task", body: choiceTask },
    ...sourceSections(sources),
    {
      title: "Decision",
      body: [
        `By \`${choice.author}\` in ${choice.commentUrl}.`,
        "",
        `Reason of the stop: ${choice.reason}`,
        ...named,
        "",
        "The decision as written:",
        "",
        fenced(choice.text),
      ].join("\n"),
    },
  ];
}

const blockedByUrls = (snapshot: IssueSnapshot) =>
  snapshot.blockedBy.map((issue) => issue.url.toLowerCase()).toSorted();

function blockedByChanged(before: IssueSnapshot, after: IssueSnapshot): boolean {
  return blockedByUrls(before).join("\n") !== blockedByUrls(after).join("\n");
}

/**
 * Where the run goes after the choice: the current snapshot when the Issue is at
 * `shape` (the Shape round follows); `undefined` otherwise. For a delivery stage
 * (the decision left a shaped Issue as it was), the re-route after the stage continues
 * delivery; for a paused, closed or `pending` Issue, the wake that clears it does.
 */
async function continueAfter(job: StageJob, issue: IssueRef) {
  freshReads(job.client);
  const snapshot = await readIssueSnapshot(job.client, issue, issue.number);
  const stage = deriveStage(snapshot);
  if (stage.stage === "shape") {
    return snapshot;
  }
  job.deps.log(`After the decision the Issue is at ${stage.stage}; no Shape round`);
  return undefined;
}

/**
 * Applies a pending choice before the Shape round: W0 stores a new decision as
 * `chosen`; the read-only choice role returns the decision's Issue change and the
 * parts Core does not apply (posted as `Not applied:` lines from W1 on); after a
 * recheck (paused, closed or `pending` → nothing written; a newer decision or an
 * Issue edit → the role runs again on the fresh reads) Core writes W1 `applying`, W2
 * the body, W3 the Blocked by edges, W4 removes `shaped` when the change changed a
 * shaped Issue, and W5 `applied`. A redo that finds `applying` drops the choice and
 * stops with `STAGE_CHOICE_INTERRUPTED`, so an Issue edit is never repeated blindly.
 * Returns the snapshot to shape, or `undefined` when no Shape round runs.
 */
export async function applyChoice(
  job: StageJob,
  issue: IssueRef,
  initial: ChoiceState,
): Promise<IssueSnapshot | undefined> {
  const { client, deps, context } = job;
  const redact = (text: string) => redactToken(text, context.token);
  let state = initial;
  for (;;) {
    const { choice } = state;
    if (state.status === "new") {
      await saveChoice(client, issue, choice, "chosen");
      deps.log(`Saved ${describeChoice(choice)}`);
    }
    if (state.status === "applying") {
      await saveChoice(client, issue, choice, "dropped", [
        "Why: an earlier application stopped part way; Nibfin did not finish it.",
      ]);
      throw new StageError(
        "STAGE_CHOICE_INTERRUPTED",
        `Applying ${describeChoice(choice)} stopped ` +
          "part way, so it may be partly applied. Check the Issue body and its " +
          "Blocked by against the `choice` comment, fix them if needed, then remove " +
          "`pending`; Nibfin does not apply this decision again.",
      );
    }
    const before = await readIssueSnapshot(client, issue, issue.number);
    const sources = await readShapeSources(client, before);
    deps.log(`${describeChoice(choice)}: ${shapeChoiceRole.title}`);
    const sections = choiceSections(choice, sources);
    const message = await runStageAgent(job, shapeChoiceRole, sections);
    const result = parseChoiceResult(message, sources.issue.body);
    if (result.outcome === "blocked") {
      const reason = redact(result.reason);
      await saveChoice(client, issue, choice, "dropped", [
        `Why: ${shapeChoiceRole.title} returned blocked: ${reason}`,
      ]);
      return blockShape(client, issue, shapeChoiceRole.title, reason);
    }
    freshReads(client);
    const after = await readIssueSnapshot(client, issue, issue.number);
    const stage = deriveStage(after);
    if (stage.stage !== "shape" && !isDeliveryStage(stage)) {
      deps.log(`The Issue is ${describeStage(stage)}; the decision is not applied yet`);
      return undefined;
    }
    const fresh = await readChoice(client, issue);
    if (!pendingChoice(fresh)) {
      deps.log("The choice is no longer pending; nothing to apply");
      return continueAfter(job, issue);
    }
    const current = await readShapeSources(client, after);
    const changed =
      fresh.status !== "chosen" ||
      !sameDecision(fresh.choice, choice) ||
      issueTextChanged(sources, current) ||
      blockedByChanged(before, after);
    if (changed) {
      deps.log("The Issue or the decision changed while the change was prepared");
      state = fresh;
      continue;
    }
    const body = result.body === null ? null : redact(result.body);
    const summary = redact(result.changeSummary);
    const edges = result.blockedBy;
    const details = [
      `Change: ${summary}`,
      ...(edges.length === 0 ? [] : [`Blocked by to add: ${edges.join(", ")}`]),
    ];
    const notApplied = result.notApplied.map(redact);
    await saveChoice(client, issue, choice, "applying", details, notApplied);
    let edited = false;
    if (body !== null && body !== current.issue.body) {
      await updateIssueBody(client, issue, body);
      edited = true;
    }
    const blocked = { ref: issue, url: after.issue.url };
    for (const url of edges) {
      const blocker = await readIssueId(client, parseIssueUrl(url));
      edited = (await addBlockedBy(client, blocked, blocker)) || edited;
    }
    if (edited && after.issue.labels.includes(nibfinLabels.shaped)) {
      const labels = await setLabels(client, issue, { remove: [nibfinLabels.shaped] });
      if (labels.includes(nibfinLabels.shaped)) {
        throw unconfirmed("remove shaped", "The read-back labels still have shaped");
      }
    }
    const outcome = edited ? "The Issue was changed as above." : "No Issue change.";
    const done = [...details, outcome];
    await saveChoice(client, issue, choice, "applied", done, notApplied);
    deps.log(
      `Applied ${describeChoice(choice)}: ${edited ? summary : "no Issue change"}`,
    );
    return continueAfter(job, issue);
  }
}
