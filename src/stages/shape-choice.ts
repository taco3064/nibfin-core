// The Shape stage applies the option a Collaborator chose on a repair record before
// it shapes (#779, Proposal R4.51). See "Chosen option" in README.md.
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
  saveChoice,
} from "./choice.ts";
import { describeStage } from "./deliver-eligibility.ts";
import { StageError } from "./errors.ts";
import { redactToken } from "./git.ts";
import type { PromptSection } from "./prompt.ts";
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
  "A Collaborator chose the option below on Nibfin's repair record of this Issue " +
  "(Proposal R4.51). Return the Issue change that option describes: the complete " +
  "new Issue body (or `null` when the body stays as it is) and any `Blocked by` " +
  "Issue URLs to add. Keep everything the option does not change, and keep every " +
  "`Origin:` line of the current body. Core writes the change; do not shape the " +
  "Issue.";

function choiceSections(choice: Choice, sources: ShapeSources): PromptSection[] {
  return [
    { title: "Task", body: choiceTask },
    ...sourceSections(sources),
    {
      title: "Chosen option",
      body: [
        `Option ${choice.option}, chosen in ${choice.commentUrl}.`,
        "",
        `Reason of the stop: ${choice.reason}`,
        "",
        choice.optionText,
      ].join("\n"),
    },
  ];
}

const sameChoice = (a: Choice, b: Choice) =>
  a.for === b.for && a.option === b.option && a.comment === b.comment;

const blockedByUrls = (snapshot: IssueSnapshot) =>
  snapshot.blockedBy.map((issue) => issue.url.toLowerCase()).toSorted();

function blockedByChanged(before: IssueSnapshot, after: IssueSnapshot): boolean {
  return blockedByUrls(before).join("\n") !== blockedByUrls(after).join("\n");
}

/**
 * Where the run goes after the choice: the current snapshot when the Issue is at
 * `shape` (the Shape round follows); `undefined` otherwise. For a delivery stage
 * (the option left a shaped Issue as it was), the re-route after the stage continues
 * delivery; for a paused, closed or `pending` Issue, the wake that clears it does.
 */
async function continueAfter(job: StageJob, issue: IssueRef) {
  freshReads(job.client);
  const snapshot = await readIssueSnapshot(job.client, issue, issue.number);
  const stage = deriveStage(snapshot);
  if (stage.stage === "shape") {
    return snapshot;
  }
  job.deps.log(`After the chosen option the Issue is at ${stage.stage}; no Shape round`);
  return undefined;
}

/**
 * Applies a pending choice before the Shape round (#779): W0 stores a new decision as
 * `chosen`; the read-only choice role returns the option's Issue change; after a
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
      deps.log(`Saved option ${choice.option} chosen in ${choice.commentUrl}`);
    }
    if (state.status === "applying") {
      await saveChoice(client, issue, choice, "dropped", [
        "Why: an earlier application stopped part way; Nibfin did not finish it.",
      ]);
      throw new StageError(
        "STAGE_CHOICE_INTERRUPTED",
        `Applying option ${choice.option} (chosen in ${choice.commentUrl}) stopped ` +
          "part way, so it may be partly applied. Check the Issue body and its " +
          "Blocked by against the `choice` comment, fix them if needed, then remove " +
          "`pending`; Nibfin does not apply this option again.",
      );
    }
    const before = await readIssueSnapshot(client, issue, issue.number);
    const sources = await readShapeSources(client, before);
    deps.log(`Option ${choice.option}: ${shapeChoiceRole.title}`);
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
      deps.log(`The Issue is ${describeStage(stage)}; the option is not applied yet`);
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
      !sameChoice(fresh.choice, choice) ||
      issueTextChanged(sources, current) ||
      blockedByChanged(before, after);
    if (changed) {
      deps.log("The Issue or the decision changed while the option was prepared");
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
    await saveChoice(client, issue, choice, "applying", details);
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
    await saveChoice(client, issue, choice, "applied", [...details, outcome]);
    deps.log(`Applied option ${choice.option}: ${edited ? summary : "no Issue change"}`);
    return continueAfter(job, issue);
  }
}
