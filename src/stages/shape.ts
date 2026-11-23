import {
  type ActingClient,
  deriveStage,
  type IssueRef,
  readIssueSnapshot,
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
import { type NextAction, noNextAction, writeNextAction } from "./next.ts";
import type { PromptSection, StageRole } from "./prompt.ts";
import { notAtShape, publishShape, shapeBlockedCommentKey } from "./shape-publish.ts";
import {
  parseAuthorResult,
  parseValidatorResult,
  shapeAuthorRole,
  shapeValidatorRole,
} from "./shape-roles.ts";
import {
  issueTextChanged,
  readShapeSources,
  type ShapeSources,
  sourceSections,
} from "./shape-sources.ts";
import {
  readCurrentShape,
  readShapeWrong,
  type ShapeWrongReport,
} from "./shape-wrong.ts";

export { shapeBlockedCommentKey } from "./shape-publish.ts";
export { shapeCommentKey } from "./shape-sources.ts";

function describeStage(stage: Stage): string {
  return stage.stage === "ineligible" ? `ineligible (${stage.reason})` : stage.stage;
}

type SnapshotReader = Pick<StageJob, "context" | "client" | "deps">;

/** The current snapshot and its derived stage; logs a stage other than Shape. */
async function readStage(job: SnapshotReader) {
  const { context, client, deps } = job;
  const snapshot = await readIssueSnapshot(client, context.repo, context.issue);
  const stage = deriveStage(snapshot);
  if (stage.stage !== "shape") {
    const where = `${context.repo.owner}/${context.repo.repo}#${context.issue}`;
    deps.log(`${where} is not at the shape stage: ${describeStage(stage)}`);
  }
  return { snapshot, stage };
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
const rewriteTask =
  "Rewrite the Shape: the previous one was found wrong. Use the reason below and " +
  "the previous Shape as reference, and return the complete rewritten Shape.";
const reviseTask =
  "Revise the previous proposed Shape so that it resolves every Validator finding, " +
  "and return the complete revised Shape.";

const reasonTitle = "Why the previous Shape is wrong";
const resolvedNote =
  "This report is already marked resolved by the current Shape; check that the " +
  "Shape still resolves it.";

/** The reason of an active `shape-wrong` report as a prompt section. */
function reasonSection(report: ShapeWrongReport): PromptSection {
  const body = report.unresolved ? report.reason : `${report.reason}\n\n${resolvedNote}`;
  return { title: reasonTitle, body };
}

interface RoundState {
  round: number;
  /** The proposed Shape; empty when the Author has not proposed one yet. */
  shape: string;
  /** Set when the Validator required changes to `shape`. */
  revision?: Revision;
  sources: ShapeSources;
  /** An active report that the previous Shape is wrong; every role reads it. */
  report?: ShapeWrongReport;
  /** The Shape reported wrong while the report is pending: the Author rewrites it. */
  wrongShape?: string;
}

async function author(job: StageJob, issue: IssueRef, state: RoundState) {
  const { revision, report, wrongShape } = state;
  const rewrite = revision === undefined && wrongShape !== undefined;
  const task = revision !== undefined ? reviseTask : rewrite ? rewriteTask : proposeTask;
  const sections: PromptSection[] = [
    { title: "Task", body: task },
    ...sourceSections(state.sources),
  ];
  if (rewrite) {
    sections.push({ title: "Previous Shape", body: wrongShape });
  }
  if (revision !== undefined) {
    sections.push(
      { title: "Previous proposed Shape", body: revision.previous },
      { title: "Validator findings", body: listFindings(revision.findings) },
    );
  }
  if (report !== undefined) {
    sections.push(reasonSection(report));
  }
  const message = await runStageAgent(job, shapeAuthorRole, sections);
  const result = parseAuthorResult(message);
  if (result.outcome === "blocked") {
    return block(job, issue, shapeAuthorRole, result.reason);
  }
  return result.shape;
}

const validateTask = "Validate the proposed Shape for the current Issue independently.";
const resolvesTask =
  " Also check that it resolves why the previous Shape was found wrong (below).";

/** The Validator sees only the sources, the proposed Shape and an active report. */
async function validate(job: StageJob, state: RoundState, shape: string) {
  const { report } = state;
  const sections: PromptSection[] = [
    {
      title: "Task",
      body: report === undefined ? validateTask : validateTask + resolvesTask,
    },
    ...sourceSections(state.sources),
    { title: "Proposed Shape", body: shape },
  ];
  if (report !== undefined) {
    sections.push(reasonSection(report));
  }
  const message = await runStageAgent(job, shapeValidatorRole, sections);
  return parseValidatorResult(message);
}

/**
 * The Shape stage: an Author proposes (or revises, or rewrites a Shape reported
 * wrong), a separate Validator decides, and only an approved Shape for the
 * still-current Issue is published. Writes the next action (none unless a rewrite
 * restarts delivery, see `publishShape` and `notAtShape`) and returns the exit code;
 * stops with `STAGE_BLOCKED`, `STAGE_RESULT_INVALID` or another coded error.
 */
export async function runShapeStage(
  context: JobContext,
  client: ActingClient,
  deps: StageDeps = defaultStageDeps,
): Promise<number> {
  let next: NextAction;
  try {
    next = await shapeStage(context, client, deps);
  } catch (error) {
    await writeNextAction(context, noNextAction);
    throw error;
  }
  await writeNextAction(context, next);
  return 0;
}

async function shapeStage(
  context: JobContext,
  client: ActingClient,
  deps: StageDeps,
): Promise<NextAction> {
  const issue = issueOf(context);
  const { snapshot, stage } = await readStage({ context, client, deps });
  if (stage.stage !== "shape") {
    return notAtShape({ client, issue, log: deps.log }, stage);
  }
  const job = await prepareStageJob(context, client, deps);
  const sources = await readShapeSources(client, snapshot);
  const current = await readCurrentShape(client, issue);
  const report = await readShapeWrong(client, issue, current?.version, deps.log);
  const active = report?.active === true ? report : undefined;
  if (report?.pending === true) {
    deps.log(`${report.comment.url} reports the Shape wrong; rewriting it`);
    const wrongShape = current?.text ?? "";
    return shapeRound(job, issue, { round: 1, shape: "", sources, report, wrongShape });
  }
  const shape = current?.text ?? "";
  return shapeRound(job, issue, { round: 1, shape, sources, report: active });
}

/**
 * One round: the Author proposes or revises when needed, then a fresh Validator
 * decides. Rejections and Issue edits start another round, without a limit.
 */
async function shapeRound(
  job: StageJob,
  issue: IssueRef,
  state: RoundState,
): Promise<NextAction> {
  const { round, revision, sources } = state;
  const { deps } = job;
  let { shape } = state;
  if (shape === "" || revision !== undefined) {
    deps.log(`Round ${round}: ${shapeAuthorRole.title}`);
    shape = await author(job, issue, state);
  }
  deps.log(`Round ${round}: ${shapeValidatorRole.title}`);
  const verdict = await validate(job, state, shape);
  if (verdict.outcome === "blocked") {
    return block(job, issue, shapeValidatorRole, verdict.reason);
  }
  const next = { ...state, round: round + 1, shape, revision: undefined };
  if (verdict.outcome === "changes-required") {
    deps.log(`Round ${round}: changes required\n${listFindings(verdict.findings)}`);
    const changes = { previous: shape, findings: verdict.findings };
    return shapeRound(job, issue, { ...next, revision: changes });
  }
  const { snapshot, stage } = await readStage(job);
  if (stage.stage !== "shape") {
    return noNextAction;
  }
  const current = await readShapeSources(job.client, snapshot);
  if (issueTextChanged(sources, current)) {
    deps.log(`Round ${round}: the Issue changed; validating again`);
    return shapeRound(job, issue, { ...next, sources: current });
  }
  return publishShape({ client: job.client, issue, log: deps.log }, shape);
}
