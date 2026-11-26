import {
  type ActingClient,
  checkAssignable,
  closeIssueAs,
  deriveStage,
  GitHubError,
  type IssueRef,
  type IssueSnapshot,
  nibfinLabels,
  type OriginIssue,
  readIssueSnapshot,
  readRepositoryInventory,
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
import { type NextAction, noNextAction, writeNextAction } from "./next.ts";
import { trackProgress } from "./progress.ts";
import type { PromptSection } from "./prompt.ts";
import {
  type InvestigationResult,
  investigationRole,
  type PlannedIssue,
  type PlanResult,
  parseInvestigationResult,
  parsePlanResult,
  planRole,
  type RequestPlan,
} from "./scope-roles.ts";
import {
  type Assignability,
  assignabilitySection,
  readRequestSource,
  readScopeSources,
  requestTextChanged,
  type ScopeSources,
  scopeSections,
} from "./scope-sources.ts";

export type { RequestPlan } from "./scope-roles.ts";

/** The marked comment the Scope stage keeps on the request (Proposal R3.42). */
export const scopeRequestCommentKey = "scope-request";

/** What publication (#736) works with besides the plan. */
export interface PublishScope {
  client: ActingClient;
  /** The request. */
  issue: IssueRef;
  log: (line: string) => void;
}

/** The stage's dependencies plus the publication of a verified `PLAN_READY` plan. */
export interface ScopeDeps extends StageDeps {
  publish: (scope: PublishScope, plan: RequestPlan) => Promise<NextAction>;
}

function describeEntry(issue: PlannedIssue): string {
  const edges =
    issue.blockedBy.length === 0 ? "" : `, blocked by ${issue.blockedBy.join(", ")}`;
  return "reuse" in issue
    ? `- ${issue.key}: reuse ${issue.reuse}${edges}`
    : `- ${issue.key}: ${issue.repository} "${issue.title}"${edges}`;
}

/**
 * Until #736: logs the plan's keys, repositories, titles and edges and that
 * publication is not implemented, writes nothing and asks for no next action.
 */
export function logUnpublishedPlan(
  scope: PublishScope,
  plan: RequestPlan,
): Promise<NextAction> {
  scope.log(
    `PLAN_READY for ${plan.request}:\n${plan.issues.map(describeEntry).join("\n")}`,
  );
  scope.log(
    "Publishing a request's plan is not implemented in this version; nothing was written",
  );
  return Promise.resolve(noNextAction);
}

export const defaultScopeDeps: ScopeDeps = {
  ...defaultStageDeps,
  publish: logUnpublishedPlan,
};

function describeStage(stage: Stage): string {
  return stage.stage === "ineligible" ? `ineligible (${stage.reason})` : stage.stage;
}

type SnapshotReader = Pick<StageJob, "context" | "client" | "deps">;

/** The current snapshot, or `undefined` (logged) when the request is not at Scope. */
async function readScopeSnapshot(
  job: SnapshotReader,
): Promise<IssueSnapshot | undefined> {
  const { context, client, deps } = job;
  const snapshot = await readIssueSnapshot(client, context.repo, context.issue);
  const stage = deriveStage(snapshot);
  if (stage.stage === "scope") {
    return snapshot;
  }
  const where = `${context.repo.owner}/${context.repo.repo}#${context.issue}`;
  deps.log(`${where} is not at the scope stage: ${describeStage(stage)}`);
  return undefined;
}

/**
 * The Scope stage of a `request` Issue (Proposal R3.2–R3.11, R4.8): a read-only
 * Investigation judges feasibility, and only a feasible judgment runs the read-only
 * Plan. The stage then comments and closes as not planned (already covered), comments
 * and adds `pending` (a person must decide), or hands a verified `PLAN_READY` plan to
 * `deps.publish` in memory. Writes the next action and returns the exit code; agent,
 * result and GitHub failures are thrown with their codes.
 */
export async function runScopeStage(
  context: JobContext,
  client: ActingClient,
  deps: ScopeDeps = defaultScopeDeps,
): Promise<number> {
  const progress = trackProgress(client);
  let next: NextAction;
  try {
    next = await scopeStage(context, progress.client, deps);
  } catch (error) {
    await writeNextAction(context, noNextAction, progress.progressed);
    throw error;
  }
  await writeNextAction(context, next, progress.progressed);
  return 0;
}

async function scopeStage(
  context: JobContext,
  client: ActingClient,
  deps: ScopeDeps,
): Promise<NextAction> {
  const snapshot = await readScopeSnapshot({ context, client, deps });
  if (snapshot === undefined) {
    return noNextAction;
  }
  const skills = [investigationRole.skill, planRole.skill];
  const job = await prepareStageJob(context, client, deps, skills);
  return scopeRound(job, deps, 1, snapshot);
}

/**
 * One round: the Investigation, then the Plan only when feasible, a re-read of the
 * request, and the action. An edit of the request starts another round, without a
 * limit; a request no longer at Scope stops the stage without writing.
 */
async function scopeRound(
  job: StageJob,
  deps: ScopeDeps,
  round: number,
  snapshot: IssueSnapshot,
): Promise<NextAction> {
  const { client } = job;
  const sources = await readScopeSources(client, snapshot);
  deps.log(`Round ${round}: ${investigationRole.title}`);
  const judgment = await investigate(job, sources);
  let decision: Decision;
  if (judgment.outcome === "feasible") {
    deps.log(`Round ${round}: ${planRole.title}`);
    const plan = await planRequest(job, sources, judgment);
    decision = planDecision(sources, judgment, plan);
  } else {
    decision = judgmentDecision(judgment);
  }
  const current = await readScopeSnapshot(job);
  if (current === undefined) {
    return noNextAction;
  }
  const request = await readRequestSource(client, current);
  if (requestTextChanged(sources.request, request)) {
    deps.log(`Round ${round}: the request changed; investigating again`);
    return scopeRound(job, deps, round + 1, current);
  }
  return act({ job, deps, sources }, decision);
}

const investigateTask =
  "Judge the feasibility of the request below (Shape's Investigation, \"Feasibility " +
  'of a request"). Every GitHub fact you need is in the sections below; you cannot ' +
  "read GitHub yourself.";

async function investigate(
  job: StageJob,
  sources: ScopeSources,
): Promise<InvestigationResult> {
  const sections: PromptSection[] = [
    { title: "Task", body: investigateTask },
    ...scopeSections(sources),
  ];
  return parseInvestigationResult(await runStageAgent(job, investigationRole, sections));
}

const planTask =
  "Plan the Issues for the request below (Scope's Plan, with `## Requests`), from the " +
  "feasible judgment below. Every GitHub fact you need is in the sections below; you " +
  "cannot read GitHub yourself.";

async function planRequest(
  job: StageJob,
  sources: ScopeSources,
  judgment: Extract<InvestigationResult, { outcome: "feasible" }>,
): Promise<PlanResult> {
  const { client } = job;
  const { request } = sources;
  const inventories = [...sources.inventories];
  const names = [...new Set([request.repository, ...judgment.repositories])];
  for (const name of names.slice(1)) {
    const [owner, repo] = name.split("/");
    inventories.push(await readRepositoryInventory(client, { owner, repo }));
  }
  const rows: Assignability[] = [];
  for (const repository of names) {
    const [owner, repo] = repository.split("/");
    for (const login of request.assignees) {
      const assignable = await checkAssignable(client, { owner, repo }, login);
      rows.push({ repository, login, assignable });
    }
  }
  const investigation = [
    judgment.reason,
    "",
    `Repositories: ${judgment.repositories.join(", ")}`,
  ].join("\n");
  const sections: PromptSection[] = [
    { title: "Task", body: planTask },
    ...scopeSections({ ...sources, inventories }),
    { title: "Investigation judgment: feasible", body: investigation },
    assignabilitySection(rows),
  ];
  const message = await runStageAgent(job, planRole, sections);
  return parsePlanResult(message, {
    requestUrl: request.url,
    repositories: new Set(names),
    originUrls: new Set(sources.origins.map((issue) => issue.url)),
  });
}

interface Acting {
  job: StageJob;
  deps: ScopeDeps;
  sources: ScopeSources;
}

function listOrigins(origins: readonly OriginIssue[]): string {
  if (origins.length === 0) {
    return "None yet.";
  }
  return origins
    .map((issue) => {
      const reason = issue.stateReason === null ? "" : `, ${issue.stateReason}`;
      return `- ${issue.url} (${issue.state}${reason})`;
    })
    .join("\n");
}

function coveredBody(
  judgment: Extract<InvestigationResult, { outcome: "already-covered" }>,
) {
  const parts = [
    "Nibfin's Scope stage found this request already covered, so it is closed as " +
      "not planned.",
  ];
  if (judgment.covering !== null) {
    parts.push(`Covering Issue: ${judgment.covering}`);
  }
  parts.push(judgment.reason);
  return parts.join("\n\n");
}

/** What the stage does with the round's results. */
type Decision =
  | {
      kind: "covered";
      judgment: Extract<InvestigationResult, { outcome: "already-covered" }>;
    }
  | { kind: "person"; verdict: string; reason: string }
  | { kind: "publish"; plan: RequestPlan };

function judgmentDecision(
  judgment: Exclude<InvestigationResult, { outcome: "feasible" }>,
): Decision {
  switch (judgment.outcome) {
    case "already-covered":
      return { kind: "covered", judgment };
    case "not-feasible":
      return { kind: "person", verdict: "Not feasible", reason: judgment.reason };
    case "needs-person":
      return { kind: "person", verdict: "Needs a person", reason: judgment.reason };
  }
}

function planDecision(
  sources: ScopeSources,
  judgment: Extract<InvestigationResult, { outcome: "feasible" }>,
  plan: PlanResult,
): Decision {
  if (plan.outcome !== "PLAN_READY") {
    return { kind: "person", verdict: plan.outcome, reason: plan.reason };
  }
  if (plan.deduplication === "unverified") {
    const verdict = "PLAN_READY without verified deduplication";
    return { kind: "person", verdict, reason: plan.report };
  }
  const { report, issues } = plan;
  const request = sources.request.url;
  return {
    kind: "publish",
    plan: { request, investigation: judgment.reason, report, issues },
  };
}

function personBody(
  decision: { verdict: string; reason: string },
  origins: readonly OriginIssue[],
) {
  return [
    "Only a person can decide how this request continues, so Nibfin added `pending`.",
    `Judgment: ${decision.verdict}`,
    decision.reason,
    `The request's own Issues:\n${listOrigins(origins)}`,
    "Record the decision in the authority or change the request, then remove " +
      "`pending`; the Scope stage then starts again from the feasibility check.",
  ].join("\n\n");
}

async function act(acting: Acting, decision: Decision): Promise<NextAction> {
  const { job, deps, sources } = acting;
  const { client } = job;
  const issue = issueOf(job.context);
  if (decision.kind === "publish") {
    return deps.publish({ client, issue, log: deps.log }, decision.plan);
  }
  if (decision.kind === "covered") {
    const body = coveredBody(decision.judgment);
    const comment = await upsertMarkedComment(
      client,
      issue,
      scopeRequestCommentKey,
      body,
    );
    deps.log(`Already covered (${comment.url})`);
    if ((await readScopeSnapshot(job)) === undefined) {
      return noNextAction;
    }
    await closeIssueAs(client, issue, "not_planned");
    deps.log("Closed the request as not planned");
    return noNextAction;
  }
  const body = personBody(decision, sources.origins);
  const comment = await upsertMarkedComment(client, issue, scopeRequestCommentKey, body);
  const labels = await setLabels(client, issue, { add: [nibfinLabels.pending] });
  if (!labels.includes(nibfinLabels.pending)) {
    const operation = `add pending to ${issue.owner}/${issue.repo}#${issue.number}`;
    const cause = new Error("pending was not read back");
    throw new GitHubError("GITHUB_WRITE_UNCONFIRMED", operation, cause);
  }
  deps.log(`${decision.verdict}: a person must decide (${comment.url})`);
  return noNextAction;
}
