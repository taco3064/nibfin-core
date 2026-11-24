import { watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ActingClient,
  deriveStage,
  ensurePullRequest,
  findMarkedComment,
  type IssueRef,
  readIssueSnapshot,
  type Repo,
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
import { closingMessages } from "./closing-keywords.ts";
import type { JobContext } from "./context.ts";
import { type Eligibility, readEligibility } from "./deliver-eligibility.ts";
import {
  acceptorSections,
  type DeliverSources,
  readDeliverSources,
  writerSections,
} from "./deliver-prompts.ts";
import {
  acceptorRole,
  parseAcceptorResult,
  parseWriterResult,
  writerRole,
} from "./deliver-roles.ts";
import {
  finishShapeReport,
  ineligibleNextAction,
  reportWrongShape,
} from "./deliver-shape-wrong.ts";
import { StageError } from "./errors.ts";
import { describeFix } from "./fix-context.ts";
import {
  checkedOutBranch,
  commitsAhead,
  diffAgainstBase,
  fetchWorkspaceBranch,
  Git,
  githubRemoteUrl,
  type GitRunner,
  messagesAhead,
  prepareBranch,
  refDirectory,
  refFormat,
  runGitProcess,
} from "./git.ts";
import { type NextAction, noNextAction, writeNextAction } from "./next.ts";
import { type Progress, trackProgress } from "./progress.ts";
import {
  isUnprotected,
  matchProtected,
  protectedChanges,
  protectedPathError,
  protectedPaths,
  type ProtectedSet,
} from "./protected-paths.ts";
import { BranchPusher } from "./push.ts";
import { type RefWatcher, watchRefDirectory } from "./ref-watcher.ts";
import { requireNoOtherWriter } from "./writer-guard.ts";

/** The comment key of the report a blocked Deliver run leaves on the Issue. */
export const deliverBlockedCommentKey = "deliver-blocked";

const blockedResolvedBody =
  "Resolved: the delivery passed Accept and has a pull request.";

/** What the Deliver stage calls out to, beyond the harness; tests replace each. */
export interface DeliverDeps extends StageDeps {
  runGit: GitRunner;
  remoteUrl: (repo: Repo) => string;
  watch: typeof watch;
  /** Where Core creates its own push repository, outside the workspace. */
  coreRepoParent: string;
}

export const defaultDeliverDeps: DeliverDeps = {
  ...defaultStageDeps,
  runGit: runGitProcess,
  remoteUrl: githubRemoteUrl,
  watch,
  coreRepoParent: tmpdir(),
};

type Eligible = Extract<Eligibility, { eligible: true }>;

/** Ends the run without writing: the Issue is not (or no longer) eligible. */
class Ineligible extends Error {
  /** The re-read that found the Issue ineligible. */
  readonly eligibility: Eligibility;

  constructor(eligibility: Eligibility) {
    super("The Issue is no longer eligible");
    this.eligibility = eligibility;
  }
}

/** The Writer's report that the Shape it was given is wrong. */
interface ShapeReport {
  version: string;
  reason: string;
}

/** One Deliver run on one branch: the Writer and Accept rounds, pushes and the PR. */
class DeliverRun {
  readonly job: StageJob;
  readonly deps: DeliverDeps;
  readonly git: Git;
  readonly issue: IssueRef;
  readonly base: string;
  readonly eligible: Eligible;
  readonly fix: string | undefined;
  /** The protected paths, from the base checkout before the branch was checked out. */
  readonly protectedSet: ProtectedSet;
  readonly pusher: BranchPusher;
  readonly progress: Progress;
  /** The remote head when the run started; a push changes it. */
  readonly startHead: string | undefined;
  /** The last re-read that found the Issue no longer eligible. */
  lastCheck: Eligibility | undefined;

  constructor(options: {
    job: StageJob;
    deps: DeliverDeps;
    git: Git;
    base: string;
    eligible: Eligible;
    fix: string | undefined;
    remoteHead: string | undefined;
    protectedSet: ProtectedSet;
    progress: Progress;
  }) {
    this.progress = options.progress;
    this.startHead = options.remoteHead;
    this.job = options.job;
    this.deps = options.deps;
    this.git = options.git;
    this.base = options.base;
    this.eligible = options.eligible;
    this.fix = options.fix;
    this.protectedSet = options.protectedSet;
    this.issue = issueOf(options.job.context);
    this.pusher = new BranchPusher({
      git: options.git,
      base: options.base,
      branch: this.branch,
      protectedSet: options.protectedSet,
      remoteHead: options.remoteHead,
      beforePush: () => this.stillEligible(),
      log: options.deps.log,
    });
  }

  get branch(): string {
    return this.eligible.branch;
  }

  get context(): JobContext {
    return this.job.context;
  }

  /** Whether the run wrote to GitHub or pushed. */
  get progressed(): boolean {
    return this.progress.progressed || this.pusher.remoteHead !== this.startHead;
  }

  /** Re-reads GitHub: the Issue must still be eligible for this reason and branch. */
  async stillEligible(): Promise<boolean> {
    const now = await readEligibility(this.job.client, this.context);
    if (now.eligible && now.branch === this.branch) {
      return true;
    }
    const where = now.eligible ? `on ${now.branch}` : now.description;
    this.deps.log(`The Issue is no longer eligible (${where}); stopping without writing`);
    this.lastCheck = now;
    return false;
  }

  /** Re-checks eligibility; ends the run (`Ineligible`) when it no longer holds. */
  async requireEligible(): Promise<void> {
    if (!(await this.stillEligible())) {
      throw new Ineligible(this.lastCheck!);
    }
  }

  async sources(): Promise<DeliverSources> {
    const url = this.eligible.snapshot.issue.url;
    const sources = await readDeliverSources(this.job.client, this.issue, url);
    if (sources === undefined) {
      return this.block("Deliver stage", "The Issue has no approved Shape comment.");
    }
    return sources;
  }

  /** Reports a blocked run on the Issue and stops with `STAGE_BLOCKED`. */
  async block(title: string, reason: string): Promise<never> {
    const body = `The delivery is blocked (${title}).\n\n${reason}`;
    const { client } = this.job;
    const key = deliverBlockedCommentKey;
    const comment = await upsertMarkedComment(client, this.issue, key, body);
    await writeNextAction(this.context, noNextAction, this.progressed);
    const message = `${title} returned blocked (${comment.url}):\n${reason}`;
    throw new StageError("STAGE_BLOCKED", message);
  }

  /** Watches the branch ref while the Writer runs, if the ref backend allows it. */
  async startWatcher(): Promise<RefWatcher | undefined> {
    if ((await refFormat(this.git)) === "reftable") {
      this.deps.log(
        "The workspace uses the reftable ref backend: progress is saved by the " +
          "final push only",
      );
      return undefined;
    }
    const directory = await refDirectory(this.git, this.branch);
    const onEvent = () => void this.pusher.request();
    return watchRefDirectory(directory, onEvent, this.deps);
  }

  /**
   * One Writer run; on a branch without an open PR its commits are pushed. Returns
   * the Writer's report when it finds the Shape it was given wrong.
   */
  async write(
    round: number,
    defects: readonly string[] | undefined,
  ): Promise<ShapeReport | undefined> {
    this.deps.log(`Round ${round}: ${writerRole.title}`);
    const sources = await this.sources();
    const sections = writerSections({
      sources,
      issue: this.context.issue,
      base: this.base,
      branch: this.branch,
      openPullUrl: this.eligible.openPull?.url,
      fix: this.fix,
      defects,
    });
    const saving = this.eligible.openPull === undefined;
    const watcher = saving ? await this.startWatcher() : undefined;
    let message: string;
    try {
      message = await runStageAgent(this.job, writerRole, sections);
    } catch (error) {
      watcher?.close();
      if (saving) {
        await this.pusher.request();
      }
      throw error;
    }
    watcher?.close();
    if (saving) {
      await this.pusher.flush();
    }
    this.requireActive();
    const result = parseWriterResult(message);
    if (result.outcome === "blocked") {
      return this.block(writerRole.title, result.reason);
    }
    if (result.outcome === "shape-wrong") {
      return { version: sources.shapeVersion, reason: result.reason };
    }
    await this.requireCommittedWork();
    return undefined;
  }

  requireActive(): void {
    if (this.pusher.halted) {
      throw new Ineligible(this.lastCheck!);
    }
  }

  /**
   * The Writer found the Shape wrong: when the Issue is still eligible, the report
   * goes on the Issue, `shaped` is removed, and the Shape stage is next.
   */
  async reportShape(report: ShapeReport): Promise<NextAction> {
    await this.requireEligible();
    const scope = { client: this.job.client, context: this.context, log: this.deps.log };
    return reportWrongShape(scope, report.version, report.reason);
  }

  /** The Writer must leave the branch checked out, clean and ahead of the base. */
  async requireCommittedWork(): Promise<void> {
    const branch = await this.git.probe(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (branch.stdout.trim() !== this.branch) {
      const message = `The Writer left the workspace off ${this.branch}`;
      throw new StageError("STAGE_WORKSPACE_MODIFIED", message);
    }
    const status = await this.git.run(["status", "--porcelain", "--untracked-files=all"]);
    if (status.trim() !== "") {
      const message = `The Writer left uncommitted changes:\n${status.trimEnd()}`;
      throw new StageError("STAGE_WORKSPACE_MODIFIED", message);
    }
    if ((await commitsAhead(this.git, this.base)) === 0) {
      const message = `The Writer returned done without commits ahead of ${this.base}`;
      throw new StageError("STAGE_RESULT_INVALID", message);
    }
  }

  /** Commits that would close the Issue on merge are a defect for the Writer. */
  async closingDefects(): Promise<string[] | undefined> {
    const messages = closingMessages(
      await messagesAhead(this.git, this.base),
      this.issue,
    );
    if (messages.length === 0) {
      return undefined;
    }
    const subjects = messages.map((message) => message.split("\n")[0]);
    return [
      `Commit messages ahead of ${this.base} contain a closing keyword for ` +
        `#${this.issue.number}, which would close the Issue before CD: ` +
        `${subjects.join("; ")}. Reword them without a closing keyword.`,
    ];
  }

  /**
   * No Acceptor runs on a head that differs from `origin/<base>` on a protected
   * path, or on a workspace with an ignored file at a protected path (which no diff
   * shows but the Acceptor would still read). The head is fetched into Core's
   * repository and compared there, as before a push.
   */
  async requireUnprotected(): Promise<void> {
    const head = await fetchWorkspaceBranch(this.git, this.branch);
    const changes = await protectedChanges(this.git, this.base, head, this.protectedSet);
    const status = await this.git.run([
      "status",
      "--porcelain",
      "--ignored",
      "--untracked-files=all",
      "-z",
    ]);
    const ignored = status
      .split("\0")
      .filter((entry) => entry.startsWith("!! "))
      .map((entry) => entry.slice(3).replace(/\/+$/, ""));
    const extra = matchProtected(ignored, this.protectedSet);
    changes.changedOnBranch = [...new Set([...changes.changedOnBranch, ...extra])].sort();
    if (!isUnprotected(changes)) {
      throw protectedPathError(this.branch, this.base, changes);
    }
  }

  /** A fresh, read-only Acceptor on the current local diff. */
  async accept(round: number) {
    this.deps.log(`Round ${round}: ${acceptorRole.title}`);
    const sections = acceptorSections({
      sources: await this.sources(),
      base: this.base,
      diff: await diffAgainstBase(this.git, this.base),
      fix: this.fix,
    });
    const verdict = parseAcceptorResult(
      await runStageAgent(this.job, acceptorRole, sections),
    );
    if (verdict.outcome === "blocked") {
      return this.block(acceptorRole.title, verdict.reason);
    }
    return verdict;
  }

  /**
   * Writer and Accept rounds until a fresh Acceptor passes; no round limit. Returns
   * the next action when the Writer found the Shape wrong instead.
   */
  async rounds(): Promise<NextAction | undefined> {
    let defects: readonly string[] | undefined;
    for (let round = 1; ; round += 1) {
      const report = await this.write(round, defects);
      if (report !== undefined) {
        return this.reportShape(report);
      }
      defects = await this.closingDefects();
      if (defects === undefined) {
        await this.requireUnprotected();
        const verdict = await this.accept(round);
        if (verdict.outcome === "pass") {
          return undefined;
        }
        defects = verdict.defects;
      }
      this.deps.log(
        `Round ${round}: defects\n${defects.map((d) => `- ${d}`).join("\n")}`,
      );
    }
  }

  /**
   * After a pass: re-checks eligibility, pushes what is pending (re-checking again
   * right before a push), then opens or reuses the pull request.
   */
  async publish(): Promise<NextAction> {
    await this.requireEligible();
    await this.pusher.flush();
    this.requireActive();
    const { client } = this.job;
    const { title } = await this.sources();
    const pull = await ensurePullRequest(client, this.context.repo, {
      branch: this.branch,
      base: this.base,
      title: `${title} (#${this.issue.number})`,
      body: `Part of #${this.issue.number}`,
    });
    this.deps.log(`Pull request: ${pull.url}`);
    const key = deliverBlockedCommentKey;
    if (await findMarkedComment(client, this.issue, key)) {
      await upsertMarkedComment(client, this.issue, key, blockedResolvedBody);
    }
    const snapshot = await readIssueSnapshot(
      client,
      this.context.repo,
      this.issue.number,
    );
    const stage = deriveStage(snapshot).stage;
    return stage === "review" ? { stage: "review", reason: null } : noNextAction;
  }
}

async function startRun(
  context: JobContext,
  progress: Progress,
  deps: DeliverDeps,
  eligible: Eligible,
  coreRepo: string,
): Promise<DeliverRun> {
  const { client } = progress;
  const job = await prepareStageJob(context, client, deps);
  const git = new Git({
    workspace: context.workspace,
    coreRepo,
    remoteUrl: deps.remoteUrl(context.repo),
    token: context.token,
    run: deps.runGit,
  });
  const base = await checkedOutBranch(git);
  if (base === eligible.branch) {
    const message = "NIBFIN_WORKSPACE must have the base branch checked out";
    throw new StageError("STAGE_INPUT_INVALID", message);
  }
  // Read from the base checkout, the one whose `.nibfin.json` the agents use.
  const protectedSet = await protectedPaths(job.config, context.workspace);
  const prepared = await prepareBranch(git, {
    base,
    branch: eligible.branch,
    actor: client.actor,
  });
  const fixOptions = { client, repo: context.repo, redact: (t: string) => git.redact(t) };
  const fix =
    eligible.fix === undefined ? undefined : await describeFix(fixOptions, eligible.fix);
  return new DeliverRun({
    job,
    deps,
    git,
    base,
    eligible,
    fix,
    remoteHead: prepared.remoteHead,
    protectedSet,
    progress,
  });
}

/**
 * The Deliver stage: on an eligible Issue, a Writer implements (or fixes) the Shape on
 * the Issue's branch, Core pushes its commits, a fresh read-only Acceptor checks the
 * local diff, and only after a pass Core pushes what is pending and opens or reuses
 * the pull request. Returns the exit code; stops with `STAGE_WRITER_ACTIVE`,
 * `STAGE_BLOCKED`, `STAGE_PUSH_REJECTED`, `STAGE_PROTECTED_PATH` or another coded
 * error.
 */
export async function runDeliverStage(
  context: JobContext,
  actingClient: ActingClient,
  deps: DeliverDeps = defaultDeliverDeps,
): Promise<number> {
  const where = `${context.repo.owner}/${context.repo.repo}#${context.issue}`;
  const progress = trackProgress(actingClient);
  const { client } = progress;
  const scope = { client, context, log: deps.log };
  const eligibility = await readEligibility(client, context);
  let redo: NextAction | undefined;
  try {
    redo = await finishShapeReport(scope, eligibility);
  } catch (error) {
    await writeNextAction(context, noNextAction, progress.progressed);
    throw error;
  }
  if (redo !== undefined) {
    await writeNextAction(context, redo, progress.progressed);
    return 0;
  }
  if (!eligibility.eligible) {
    deps.log(`${where} is not at the deliver stage: ${eligibility.description}`);
    const next = await ineligibleNextAction(scope, eligibility, true);
    await writeNextAction(context, next, progress.progressed);
    return 0;
  }
  try {
    await requireNoOtherWriter(client, context);
  } catch (error) {
    await writeNextAction(context, noNextAction, progress.progressed);
    throw error;
  }
  const coreRepo = await mkdtemp(join(deps.coreRepoParent, "nibfin-push-"));
  let run: DeliverRun | undefined;
  try {
    run = await startRun(context, progress, deps, eligibility, coreRepo);
    const reported = await run.rounds();
    const next = reported ?? (await run.publish());
    await writeNextAction(context, next, run.progressed);
  } catch (error) {
    if (!(error instanceof Ineligible)) {
      throw error;
    }
    const next = await ineligibleNextAction(scope, error.eligibility, false);
    // Only a started run re-checks eligibility, so `run` is set here.
    await writeNextAction(context, next, run!.progressed);
  } finally {
    await rm(coreRepo, { recursive: true, force: true });
  }
  return 0;
}
