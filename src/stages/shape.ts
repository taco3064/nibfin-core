import {
  type ActingClient,
  commentMarker,
  deriveStage,
  findMarkedComment,
  GitHubError,
  type IssueRef,
  nibfinLabels,
  readIssueSnapshot,
  setLabels,
  type Stage,
  upsertMarkedComment,
} from "../github/index.ts";
import {
  defaultStageDeps,
  issueOf,
  prepareStageJob,
  runStageAgent,
  type StageDeps,
  type StageJob,
} from "./agent.ts";
import type { JobContext } from "./context.ts";
import { StageError } from "./errors.ts";
import type { PromptSection, StageRole } from "./prompt.ts";
import {
  parseAuthorResult,
  parseValidatorResult,
  shapeAuthorRole,
  shapeValidatorRole,
} from "./shape-roles.ts";
import {
  issueTextChanged,
  readShapeSources,
  shapeCommentKey,
  shapeOfComment,
  type ShapeSources,
  sourceSections,
} from "./shape-sources.ts";

export { shapeCommentKey } from "./shape-sources.ts";

/** The comment key of the report a blocked Shape leaves on the Issue. */
export const shapeBlockedCommentKey = "shape-blocked";

const blockedResolvedBody = "Resolved: the Shape was approved and published.";

function describeStage(stage: Stage): string {
  return stage.stage === "ineligible" ? `ineligible (${stage.reason})` : stage.stage;
}

type SnapshotReader = Pick<StageJob, "context" | "client" | "deps">;

/** The current snapshot when the Issue is at the Shape stage; logs it otherwise. */
async function eligibleSnapshot(job: SnapshotReader) {
  const { context, client, deps } = job;
  const snapshot = await readIssueSnapshot(client, context.repo, context.issue);
  const stage = deriveStage(snapshot);
  if (stage.stage === "shape") {
    return snapshot;
  }
  const where = `${context.repo.owner}/${context.repo.repo}#${context.issue}`;
  deps.log(`${where} is not at the shape stage: ${describeStage(stage)}`);
  return undefined;
}

function listFindings(findings: readonly string[]): string {
  return findings.map((finding) => `- ${finding}`).join("\n");
}

/** Reports a blocked role on the Issue and stops with `STAGE_BLOCKED`. */
async function block(
  job: StageJob,
  issue: IssueRef,
  role: StageRole,
  reason: string,
): Promise<never> {
  const body = `The Shape is blocked (${role.title}).\n\n${reason}`;
  const { client } = job;
  const comment = await upsertMarkedComment(client, issue, shapeBlockedCommentKey, body);
  const message = `${role.title} returned blocked (${comment.url}):\n${reason}`;
  throw new StageError("STAGE_BLOCKED", message);
}

interface Revision {
  previous: string;
  findings: readonly string[];
}

const proposeTask = "Propose the Shape for the current Issue.";
const reviseTask =
  "Revise the previous proposed Shape so that it resolves every Validator finding, " +
  "and return the complete revised Shape.";

async function author(
  job: StageJob,
  issue: IssueRef,
  sources: ShapeSources,
  revision: Revision | undefined,
): Promise<string> {
  const task = revision === undefined ? proposeTask : reviseTask;
  const sections: PromptSection[] = [
    { title: "Task", body: task },
    ...sourceSections(sources),
  ];
  if (revision !== undefined) {
    sections.push(
      { title: "Previous proposed Shape", body: revision.previous },
      { title: "Validator findings", body: listFindings(revision.findings) },
    );
  }
  const message = await runStageAgent(job, shapeAuthorRole, sections);
  const result = parseAuthorResult(message);
  if (result.outcome === "blocked") {
    return block(job, issue, shapeAuthorRole, result.reason);
  }
  return result.shape;
}

/** The Validator sees only the sources and the proposed Shape, never the Author's run. */
async function validate(job: StageJob, sources: ShapeSources, shape: string) {
  const sections: PromptSection[] = [
    {
      title: "Task",
      body: "Validate the proposed Shape for the current Issue independently.",
    },
    ...sourceSections(sources),
    { title: "Proposed Shape", body: shape },
  ];
  const message = await runStageAgent(job, shapeValidatorRole, sections);
  return parseValidatorResult(message);
}

function unconfirmed(operation: string, reason: string): GitHubError {
  return new GitHubError("GITHUB_WRITE_UNCONFIRMED", operation, new Error(reason));
}

/** Publishes the approved Shape and `shaped`, and confirms both by reading them back. */
async function publish(job: StageJob, issue: IssueRef, shape: string): Promise<void> {
  const { client, deps } = job;
  const comment = await upsertMarkedComment(client, issue, shapeCommentKey, shape);
  if (comment.body !== `${commentMarker(shapeCommentKey)}\n${shape}`) {
    throw unconfirmed("publish the Shape", "The read-back comment differs");
  }
  const labels = await setLabels(client, issue, { add: [nibfinLabels.shaped] });
  if (!labels.includes(nibfinLabels.shaped)) {
    throw unconfirmed("add shaped", "The read-back labels lack shaped");
  }
  if (await findMarkedComment(client, issue, shapeBlockedCommentKey)) {
    await upsertMarkedComment(client, issue, shapeBlockedCommentKey, blockedResolvedBody);
  }
  deps.log(`Published the Shape: ${comment.url}`);
}

/**
 * The Shape stage: an Author proposes (or revises), a separate Validator decides, and
 * only an approved Shape for the still-current Issue is published. Returns the exit
 * code; stops with `STAGE_BLOCKED`, `STAGE_RESULT_INVALID` or another coded error.
 */
export async function runShapeStage(
  context: JobContext,
  client: ActingClient,
  deps: StageDeps = defaultStageDeps,
): Promise<number> {
  const snapshot = await eligibleSnapshot({ context, client, deps });
  if (snapshot === undefined) {
    return 0;
  }
  const job = await prepareStageJob(context, client, deps);
  const issue = issueOf(context);
  const sources = await readShapeSources(client, snapshot);
  const existing = await findMarkedComment(client, issue, shapeCommentKey);
  const shape = existing === undefined ? "" : shapeOfComment(existing.body);
  return shapeRound(job, issue, { round: 1, shape, sources });
}

interface RoundState {
  round: number;
  /** The proposed Shape; empty when the Author has not proposed one yet. */
  shape: string;
  /** Set when the Validator required changes to `shape`. */
  revision?: Revision;
  sources: ShapeSources;
}

/**
 * One round: the Author proposes or revises when needed, then a fresh Validator
 * decides. Rejections and Issue edits start another round, without a limit.
 */
async function shapeRound(job: StageJob, issue: IssueRef, state: RoundState) {
  const { round, revision, sources } = state;
  const { deps } = job;
  let { shape } = state;
  if (shape === "" || revision !== undefined) {
    deps.log(`Round ${round}: ${shapeAuthorRole.title}`);
    shape = await author(job, issue, sources, revision);
  }
  deps.log(`Round ${round}: ${shapeValidatorRole.title}`);
  const verdict = await validate(job, sources, shape);
  if (verdict.outcome === "blocked") {
    return block(job, issue, shapeValidatorRole, verdict.reason);
  }
  const next = { round: round + 1, shape, sources };
  if (verdict.outcome === "changes-required") {
    deps.log(`Round ${round}: changes required\n${listFindings(verdict.findings)}`);
    const changes = { previous: shape, findings: verdict.findings };
    return shapeRound(job, issue, { ...next, revision: changes });
  }
  const snapshot = await eligibleSnapshot(job);
  if (snapshot === undefined) {
    return 0;
  }
  const current = await readShapeSources(job.client, snapshot);
  if (issueTextChanged(sources, current)) {
    deps.log(`Round ${round}: the Issue changed; validating again`);
    return shapeRound(job, issue, { ...next, sources: current });
  }
  await publish(job, issue, shape);
  return 0;
}
