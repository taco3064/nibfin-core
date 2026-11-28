// The repair stage Job (#778, Proposal R4.40–R4.50): the read-only repair agent
// classifies a stop the code could not decide; Core checks its result and performs
// the one allowed step (R4.48). See "Repair agent" in README.md.
import {
  type ActingClient,
  addBlockedBy,
  deriveStage,
  findMarkedComment,
  freshReads,
  type IssueRecord,
  type IssueRef,
  type IssueSnapshot,
  nibfinLabels,
  type PullRequestState,
  readIssueId,
  readIssueRecord,
  readIssueSnapshot,
  readPullRequestFiles,
  readRepositoryInventory,
  readRunJobs,
  type Repo,
  type RepositoryInventory,
  type RequiredCheckResult,
  rerunJob,
  type Stage,
  updateIssueBody,
  upsertMarkedComment,
} from "../github/index.ts";
import {
  issueOf,
  prepareStageJob,
  runStageAgent,
  type StageDeps,
  type StageJob,
} from "./agent.ts";
import type { JobContext } from "./context.ts";
import { jobLogTail } from "./fix-context.ts";
import { redactToken } from "./git.ts";
import { readCause } from "./pending.ts";
import { fenced, type PromptSection } from "./prompt.ts";
import { pendingEvidence, readRepairNeed, release, type RepairNeed } from "./repair.ts";
import {
  formatOptions,
  formatRepairRecord,
  indent,
  type RepairAction,
  repairCommentKey,
  type RepairStatus,
  type RepairText,
} from "./repair-record.ts";
import {
  type RepairClass,
  type RepairOption,
  repairClasses,
  parseIssueUrl,
  type RepairResult,
  repairRole,
  parseRepairResult,
} from "./repair-roles.ts";

/** Where a Nibfin flow error is reported (R4.46); Core decides it, not the agent. */
export const bugReportUrl = "https://github.com/taco3064/nibfin-core/issues/new";

/** The `handled` key of a stop whose `pending` comment has no code. */
export const noCodeKey = "NONE";

/** The repair stage's dependencies, plus the route after `pending` is removed. */
export interface RepairStageDeps extends StageDeps {
  /** Reads the Issue's route again and dispatches it once (R4.42). */
  reroute: (context: JobContext, client: ActingClient) => Promise<void>;
}

/** The Issue as one read sees it, and whether the agent's record covers its stop. */
interface Current {
  snapshot: IssueSnapshot;
  stage: Stage;
  /** The need when it resumes a record `repairing agent`; otherwise `undefined`. */
  agent: (RepairNeed & { kind: "resume" }) | undefined;
}

async function readCurrent(client: ActingClient, issue: IssueRef): Promise<Current> {
  const snapshot = await readIssueSnapshot(client, issue, issue.number);
  const stage = deriveStage(snapshot);
  const pending = snapshot.issue.labels.includes(nibfinLabels.pending);
  const need = pending ? await readRepairNeed(client, issue) : null;
  const agent =
    need?.kind === "resume" && need.record?.action === "agent"
      ? (need as RepairNeed & { kind: "resume" })
      : undefined;
  return { snapshot, stage, agent };
}

const isPending = (stage: Stage) =>
  stage.stage === "ineligible" && stage.reason === "pending";

/**
 * What stopped the repair agent other than `pending` (a close, `pause`, or a lost
 * `scope`), and what a person does next (R4.52).
 */
function stoppedText(snapshot: IssueSnapshot): { what: string; next: string } {
  if (snapshot.issue.state === "closed") {
    return {
      what: "the Issue was closed",
      next: "reopen the Issue, then remove `pending` to run again",
    };
  }
  if (!snapshot.issue.labels.includes(nibfinLabels.scope)) {
    return {
      what: "the Issue lost its `scope` label",
      next: "add `scope` again, then remove `pending` to run again",
    };
  }
  return {
    what: "`pause` was added",
    next: "remove `pause`, then remove `pending` to run again",
  };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const categoryOf = (kind: RepairClass) => `${kind}, ${repairClasses[kind]}`;

interface RecordWrite {
  status: RepairStatus;
  action: RepairAction;
  handled: readonly string[];
  text: Omit<RepairText, "evidence">;
  /** The agent's evidence, after the stop's own. */
  evidence: readonly string[];
}

/** Writes the repair record for the stop `need` covers, redacted of the token. */
async function writeRecord(
  job: Pick<StageJob, "context" | "client">,
  need: RepairNeed,
  record: RecordWrite,
): Promise<void> {
  const items = record.evidence.map((item) => `\n  - ${oneLine(item)}`).join("");
  const body = formatRepairRecord(
    {
      for: need.pending!.digest,
      status: record.status,
      action: record.action,
      handled: record.handled,
    },
    { ...record.text, evidence: `${pendingEvidence(need.pending)}${items}` },
  );
  const issue = issueOf(job.context);
  const redacted = redactToken(body, job.context.token);
  await upsertMarkedComment(job.client, issue, repairCommentKey, redacted);
}

/**
 * The repair stage Job for an Issue whose record is `repairing agent` (#778). It
 * rechecks the Issue, runs the read-only repair agent with Core's evidence, checks
 * the result strictly (`parseRepairResult`), rechecks the Issue, and performs the one
 * step the result names. It writes nothing when the stop is no longer the one the
 * record covers, and a `needs-person` record when a pause or close stopped it.
 * Returns 0; every failure is thrown, so the CLI names the repair stage on the
 * `pending` comment (R4.50).
 */
export async function runRepairStage(
  context: JobContext,
  client: ActingClient,
  deps: RepairStageDeps,
): Promise<number> {
  const issue = issueOf(context);
  const name = `${issue.owner}/${issue.repo}#${issue.number}`;
  const before = await readCurrent(client, issue);
  if (before.agent === undefined) {
    deps.log(`${name}: no repair agent record covers the current stop; nothing to do`);
    return 0;
  }
  const need = before.agent;
  if (!isPending(before.stage)) {
    const stopped = stoppedText(before.snapshot);
    await writeRecord({ context, client }, need, {
      status: "needs-person",
      action: "advice",
      handled: need.record!.handled,
      text: {
        category: "not classified",
        reason: `The repair agent did not run: ${stopped.what}.`,
        done:
          `Nothing; ${stopped.what} before the repair agent started, so it did ` +
          "not run.",
        advice: `To have it look again, ${stopped.next}.`,
      },
      evidence: [],
    });
    deps.log(`${name}: ${stopped.what} before the repair agent started`);
    return 0;
  }
  const job = await prepareStageJob(context, client, deps, [repairRole.skill, "scope"]);
  const sources = await readRepairSources(job, before.snapshot, need);
  deps.log(`${name}: ${repairRole.title}`);
  const finalMessage = await runStageAgent(job, repairRole, repairSections(job, sources));
  const result = parseRepairResult(finalMessage, {
    body: sources.issue.body,
    guard: sources.guard,
  });
  deps.log(`${name}: repair agent: class ${result.class}, ${result.outcome}`);
  return applyResult(job, deps, sources, result);
}

/** What the agent was given, as Core read it before the run. */
interface RepairSources {
  need: RepairNeed;
  issue: IssueRecord;
  /** The `handled` key of this stop: its code, or `NONE`. */
  key: string;
  /** The key already received an automatic step (R4.47). */
  guard: boolean;
  pendingBody: string;
  code: string;
  run: string | undefined;
  runDetails: string | undefined;
  pullRequest: string | undefined;
  record: string;
  inventory: RepositoryInventory;
}

const runPattern =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/.*)?$/;

/** The run of the `- Run:` URL, only when it is a run of the execution repository. */
function runOf(url: string | undefined, runRepo: Repo | undefined) {
  const match = url === undefined ? null : runPattern.exec(url);
  if (match === null || runRepo === undefined) {
    return undefined;
  }
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!same(match[1], runRepo.owner) || !same(match[2], runRepo.repo)) {
    return undefined;
  }
  return Number(match[3]);
}

const redactor = (job: StageJob) => (text: string) =>
  redactToken(text, job.context.token);

async function describeFailedRun(job: StageJob, runId: number): Promise<string> {
  const runRepo = job.context.runRepo!;
  const jobs = await readRunJobs(job.client, runRepo, runId);
  const parts = [
    "Jobs of the latest attempt:",
    "",
    ...(jobs.length === 0
      ? ["None."]
      : jobs.map((item) => `- ${item.name}: ${item.state} (${item.url ?? "no URL"})`)),
  ];
  for (const failed of jobs.filter((item) => item.state === "failed")) {
    const tail = await jobLogTail(job.client, runRepo, redactor(job), failed.id);
    parts.push("", `### Job ${failed.name}`, "", tail);
  }
  return parts.join("\n");
}

/** The required check results of an open pull request (the snapshot reads them). */
const resultsOf = (pull: PullRequestState) => pull.ci!.results;

/** The failed required checks of `pull` that GitHub Actions created (their job ids). */
function failedActionsChecks(pull: PullRequestState | undefined): RequiredCheckResult[] {
  return (pull === undefined ? [] : resultsOf(pull)).filter(
    (result) =>
      result.state === "failed" &&
      result.source === "check-run" &&
      result.appSlug === "github-actions" &&
      result.checkRunId !== undefined,
  );
}

const openPullRequest = (snapshot: IssueSnapshot) =>
  snapshot.pullRequests.find((pull) => pull.state === "open");

async function describePullRequest(
  job: StageJob,
  pull: PullRequestState,
): Promise<string> {
  const { repo } = job.context;
  const checks = resultsOf(pull);
  const files = await readPullRequestFiles(job.client, repo, pull.number);
  const parts = [
    `URL: ${pull.url}`,
    `Head: \`${pull.headSha}\` (${pull.headRef})`,
    "",
    "Required checks:",
    "",
    ...(checks.length === 0
      ? ["None reported."]
      : checks.map(
          (check) => `- ${check.context}: ${check.state} (${check.url ?? "no URL"})`,
        )),
    "",
    "Changed files:",
    "",
    ...(files.length === 0 ? ["None."] : files.map((file) => `- ${file}`)),
  ];
  for (const check of failedActionsChecks(pull)) {
    const tail = await jobLogTail(job.client, repo, redactor(job), check.checkRunId!);
    parts.push("", `### Failed check ${check.context}`, "", tail);
  }
  return parts.join("\n");
}

async function readRepairSources(
  job: StageJob,
  snapshot: IssueSnapshot,
  need: RepairNeed,
): Promise<RepairSources> {
  const { context, client } = job;
  const ref = issueOf(context);
  const issue = await readIssueRecord(client, ref);
  const pendingBody = need.pending!.body;
  const cause = readCause(need.pending!);
  const key = cause.code ?? noCodeKey;
  const runId = runOf(cause.run, context.runRepo);
  const runDetails =
    runId === undefined ? undefined : await describeFailedRun(job, runId);
  const pull = openPullRequest(snapshot);
  const pullRequest =
    pull === undefined ? undefined : await describePullRequest(job, pull);
  // The `agent` record this Job runs for.
  const record = (await findMarkedComment(client, ref, repairCommentKey))!.body;
  const inventory = await readRepositoryInventory(client, context.repo);
  return {
    need,
    issue,
    key,
    guard: need.record!.handled.includes(key),
    pendingBody,
    code: cause.code ?? "none",
    run: cause.run,
    runDetails,
    pullRequest,
    record,
    inventory,
  };
}

const repairTask =
  "Find why the Issue below stopped with `pending` and return its one next step. " +
  "Every GitHub fact you need is in the sections below; you cannot read GitHub " +
  "yourself.";

const authorityText =
  "The product authority is the document the repository's agent instructions " +
  "designate (for example `CLAUDE.md` or `AGENTS.md` at the workspace root, a " +
  "checkout of the base branch). Read it there; cite its rules by their ids.";

const urlOf = (item: { url: string }) => item.url;
const list = (values: readonly string[]) =>
  values.length === 0 ? "none" : values.join(", ");

/** The `### Small amendments` section of the scope skill, or the whole skill. */
export function smallAmendments(scopeSkill: string): string {
  const lines = scopeSkill.split("\n");
  const start = lines.findIndex((line) => line.trim() === "### Small amendments");
  if (start === -1) {
    return scopeSkill;
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,3} /.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

function repairSections(job: StageJob, sources: RepairSources): PromptSection[] {
  const { issue, inventory } = sources;
  const assignees = issue.assignees.map((assignee) => assignee.login);
  const blockedBy = issue.blockedBy.map((item) => `${item.url} (${item.state})`);
  const body = issue.body.trim() === "" ? "(no description)" : fenced(issue.body);
  const openIssues = inventory.openIssues.map(
    (open) =>
      `- #${open.number} ${open.url}: ${oneLine(open.title)} [labels: ` +
      `${list(open.labels)}; Blocked by: ${list(open.blockedBy.map(urlOf))}]`,
  );
  const guard = sources.guard
    ? [
        "",
        "This cause already received an automatic step (Proposal R4.47): Rerun and " +
          "Amend are not accepted.",
      ]
    : [];
  const sections: PromptSection[] = [
    { title: "Task", body: repairTask },
    {
      title: "Issue",
      body: [
        `URL: ${issue.url}`,
        `Title: ${issue.title}`,
        `Labels: ${list(issue.labels)}`,
        `Assignees: ${list(assignees)}`,
        `Blocked by: ${list(blockedBy)}`,
        "",
        body,
      ].join("\n"),
    },
    {
      title: "Pending comment",
      body: [
        `Code: \`${sources.code}\``,
        `Run: ${sources.run ?? "unknown"}`,
        "",
        fenced(sources.pendingBody),
      ].join("\n"),
    },
    {
      title: "Failed run",
      body:
        sources.runDetails ??
        "Not available: the `pending` comment names no run of the execution repository.",
    },
    {
      title: "Pull request",
      body: sources.pullRequest ?? "The Issue has no open pull request.",
    },
    {
      title: "Repair record",
      body: [fenced(sources.record), ...guard].join("\n"),
    },
    {
      title: `Open Issues of ${inventory.repository}`,
      body: openIssues.length === 0 ? "None." : openIssues.join("\n"),
    },
    { title: "Product authority", body: authorityText },
    {
      title: "Small amendments (scope skill)",
      body: smallAmendments(job.skills.get("scope")!),
    },
    {
      title: "Visibility",
      body: `- ${inventory.repository} (the Issue repository): ${inventory.visibility}`,
    },
  ];
  const redact = redactor(job);
  return sections.map((section) => ({ ...section, body: redact(section.body) }));
}

const titleOf = (option: RepairOption) => oneLine(option.title);

/** The agent's proposal in one line, for a record that did not apply it. */
function proposal(result: RepairResult): string {
  switch (result.outcome) {
    case "RERUN":
      return "rerun the failed step";
    case "AMEND":
      return `amend the Issue: ${oneLine(result.changeSummary)}`;
    case "DECIDE":
      return `choose between: ${result.options.map(titleOf).join("; ")}`;
    default:
      return `follow up: ${oneLine(result.steps[0].text)}`;
  }
}

function stepsDetails(result: RepairResult & { outcome: "FOLLOW_UP" }): string {
  const steps = result.steps.map((step, index) =>
    [
      `${index + 1}. ${oneLine(step.text)}`,
      ...(step.link === undefined ? [] : [indent(`Link: ${step.link}`)]),
      ...(step.command === undefined ? [] : [indent(fenced(step.command, "sh"))]),
    ].join("\n"),
  );
  const parts = ["### Steps", "", ...steps];
  if (result.bugReport !== undefined) {
    parts.push(
      "",
      "### Bug report for Nibfin",
      "",
      `File it at ${bugReportUrl} with this title and body.`,
      "",
      `Title: ${oneLine(result.bugReport.title)}`,
      "",
      fenced(result.bugReport.body, "markdown"),
    );
  }
  return parts.join("\n");
}

/**
 * The post-agent recheck, then the one step (R4.48). The record is written first
 * (W1) in every case, so a crash leaves a record the route resumes or ends (R4.50).
 */
async function applyResult(
  job: StageJob,
  deps: RepairStageDeps,
  sources: RepairSources,
  result: RepairResult,
): Promise<number> {
  const { context, client } = job;
  const issue = issueOf(context);
  const name = `${issue.owner}/${issue.repo}#${issue.number}`;
  freshReads(client);
  const after = await readCurrent(client, issue);
  const need = sources.need;
  if (after.agent === undefined || after.agent.pending!.digest !== need.pending!.digest) {
    deps.log(`${name}: the stop changed while the repair agent worked; nothing applied`);
    return 0;
  }
  const handled = need.record!.handled;
  const shared = {
    category: categoryOf(result.class),
    reason: result.summary,
  };
  const evidence = result.evidence;
  const notApplied = async (done: string, next: string) => {
    await writeRecord(job, need, {
      status: "needs-person",
      action: "advice",
      handled,
      text: { ...shared, done, advice: next },
      evidence,
    });
    deps.log(`${name}: the repair agent's result was not applied`);
    return 0;
  };
  if (!isPending(after.stage)) {
    const stopped = stoppedText(after.snapshot);
    return notApplied(
      `Nothing; ${stopped.what} while the repair agent worked, so its result was ` +
        "not applied.",
      `The repair agent proposed to ${proposal(result)}. To have it look again, ` +
        `${stopped.next}.`,
    );
  }
  if (result.outcome === "AMEND") {
    const current = await readIssueRecord(client, issue);
    if (current.body !== sources.issue.body) {
      return notApplied(
        "Nothing; the Issue body changed while the repair agent worked.",
        `The repair agent proposed: ${oneLine(result.changeSummary)} Check whether ` +
          "it is still needed, then remove `pending`.",
      );
    }
  }
  const handledNext = [...handled, sources.key];
  switch (result.outcome) {
    case "RERUN": {
      const checks =
        result.class === "C" ? failedActionsChecks(openPullRequest(after.snapshot)) : [];
      if (checks.length > 0) {
        const names = checks.map((check) => `\`${check.context}\``).join(", ");
        await writeRecord(job, need, {
          status: "repairing",
          action: "rerun",
          handled: handledNext,
          text: {
            ...shared,
            done:
              `Re-ran the failed CI jobs ${names}. \`pending\` stays until they ` +
              "complete; then Nibfin removes it and the Issue continues.",
            advice: "None needed.",
          },
          evidence,
        });
        for (const check of checks) {
          await rerunJob(client, context.repo, check.checkRunId!);
        }
        deps.log(`${name}: re-ran ${checks.length} failed CI job(s)`);
        return 0;
      }
      await writeRecord(job, need, {
        status: "repairing",
        action: "retry",
        handled: handledNext,
        text: {
          ...shared,
          done:
            "Nibfin removes `pending` and dispatches the stage GitHub's current " +
            "state calls for, once.",
          advice:
            "None needed. If it stops for the same cause again, `pending` stays " +
            "for a person.",
        },
        evidence,
      });
      await release(client, issue);
      await deps.reroute(context, client);
      return 0;
    }
    case "AMEND": {
      const edges =
        result.blockedBy.length === 0
          ? ""
          : ` Adds Blocked by ${result.blockedBy.join(", ")}.`;
      await writeRecord(job, need, {
        status: "repairing",
        action: "amend",
        handled: handledNext,
        text: {
          ...shared,
          done:
            `Amending the Issue: ${oneLine(result.changeSummary)}${edges} Then Nibfin ` +
            "removes `pending` and the Issue continues.",
          advice:
            "None needed. If the change is wrong, revert it from the Issue's edit " +
            "history.",
        },
        evidence,
      });
      if (result.body !== null && result.body !== sources.issue.body) {
        await updateIssueBody(client, issue, result.body);
      }
      const blocked = { ref: issue, url: sources.issue.url };
      for (const url of result.blockedBy) {
        await addBlockedBy(
          client,
          blocked,
          await readIssueId(client, parseIssueUrl(url)),
        );
      }
      await release(client, issue);
      await deps.reroute(context, client);
      return 0;
    }
    case "DECIDE":
      await writeRecord(job, need, {
        status: "waiting-for-choice",
        action: "options",
        handled,
        text: {
          ...shared,
          done: "Nothing; a product decision is needed, so `pending` stays.",
          advice:
            "Reply with an option number or in your own words (or use the " +
            "Dashboard's decision comment), then remove `pending` (Proposal R4.51).",
          details: formatOptions(result.options),
        },
        evidence,
      });
      return 0;
    default:
      await writeRecord(job, need, {
        status: "needs-person",
        action: "advice",
        handled,
        text: {
          ...shared,
          done: "Nothing; `pending` stays.",
          advice:
            result.bugReport === undefined
              ? "Follow the steps below."
              : "Follow the steps below, and file the bug report below them.",
          details: stepsDetails(result),
        },
        evidence,
      });
      return 0;
  }
}
