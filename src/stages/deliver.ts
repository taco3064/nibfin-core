import { watch } from "node:fs";
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
import { StageError } from "./errors.ts";
import { describeFix } from "./fix-context.ts";
import {
  checkedOutBranch,
  commitsAhead,
  diffAgainstBase,
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
}

export const defaultDeliverDeps: DeliverDeps = {
  ...defaultStageDeps,
  runGit: runGitProcess,
  remoteUrl: githubRemoteUrl,
  watch,
};

type Eligible = Extract<Eligibility, { eligible: true }>;

/** Ends the run without writing: the Issue is not (or no longer) eligible. */
class Ineligible extends Error {}

/** One Deliver run on one branch: the Writer and Accept rounds, pushes and the PR. */
class DeliverRun {
  readonly job: StageJob;
  readonly deps: DeliverDeps;
  readonly git: Git;
  readonly issue: IssueRef;
  readonly base: string;
  readonly eligible: Eligible;
  readonly fix: string | undefined;
  readonly pusher: BranchPusher;

  constructor(options: {
    job: StageJob;
    deps: DeliverDeps;
    git: Git;
    base: string;
    eligible: Eligible;
    fix: string | undefined;
    remoteHead: string | undefined;
  }) {
    this.job = options.job;
    this.deps = options.deps;
    this.git = options.git;
    this.base = options.base;
    this.eligible = options.eligible;
    this.fix = options.fix;
    this.issue = issueOf(options.job.context);
    this.pusher = new BranchPusher({
      git: options.git,
      branch: this.branch,
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

  /** Re-reads GitHub: the Issue must still be eligible for this reason and branch. */
  async stillEligible(): Promise<boolean> {
    const now = await readEligibility(this.job.client, this.context);
    if (now.eligible && now.branch === this.branch) {
      return true;
    }
    const where = now.eligible ? `on ${now.branch}` : now.description;
    this.deps.log(`The Issue is no longer eligible (${where}); stopping without writing`);
    return false;
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
    await writeNextAction(this.context, noNextAction);
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

  /** One Writer run; on a branch without an open PR its commits are pushed. */
  async write(round: number, defects: readonly string[] | undefined): Promise<void> {
    this.deps.log(`Round ${round}: ${writerRole.title}`);
    const sections = writerSections({
      sources: await this.sources(),
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
    await this.requireCommittedWork();
  }

  requireActive(): void {
    if (this.pusher.halted) {
      throw new Ineligible();
    }
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

  /** Writer and Accept rounds until a fresh Acceptor passes; no round limit. */
  async rounds(): Promise<void> {
    let defects: readonly string[] | undefined;
    for (let round = 1; ; round += 1) {
      await this.write(round, defects);
      defects = await this.closingDefects();
      if (defects === undefined) {
        const verdict = await this.accept(round);
        if (verdict.outcome === "pass") {
          return;
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
    if (!(await this.stillEligible())) {
      throw new Ineligible();
    }
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
  client: ActingClient,
  deps: DeliverDeps,
  eligible: Eligible,
): Promise<DeliverRun> {
  const job = await prepareStageJob(context, client, deps);
  const git = new Git({
    workspace: context.workspace,
    remoteUrl: deps.remoteUrl(context.repo),
    token: context.token,
    run: deps.runGit,
  });
  const base = await checkedOutBranch(git);
  if (base === eligible.branch) {
    const message = "NIBFIN_WORKSPACE must have the base branch checked out";
    throw new StageError("STAGE_INPUT_INVALID", message);
  }
  const prepared = await prepareBranch(git, {
    base,
    branch: eligible.branch,
    actor: context.actor,
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
  });
}

/**
 * The Deliver stage: on an eligible Issue, a Writer implements (or fixes) the Shape on
 * the Issue's branch, Core pushes its commits, a fresh read-only Acceptor checks the
 * local diff, and only after a pass Core pushes what is pending and opens or reuses
 * the pull request. Returns the exit code; stops with `STAGE_WRITER_ACTIVE`,
 * `STAGE_BLOCKED`, `STAGE_PUSH_REJECTED` or another coded error.
 */
export async function runDeliverStage(
  context: JobContext,
  client: ActingClient,
  deps: DeliverDeps = defaultDeliverDeps,
): Promise<number> {
  const where = `${context.repo.owner}/${context.repo.repo}#${context.issue}`;
  const eligibility = await readEligibility(client, context);
  if (!eligibility.eligible) {
    deps.log(`${where} is not at the deliver stage: ${eligibility.description}`);
    await writeNextAction(context, noNextAction);
    return 0;
  }
  try {
    await requireNoOtherWriter(client, context);
  } catch (error) {
    await writeNextAction(context, noNextAction);
    throw error;
  }
  const run = await startRun(context, client, deps, eligibility);
  try {
    await run.rounds();
    await writeNextAction(context, await run.publish());
  } catch (error) {
    if (!(error instanceof Ineligible)) {
      throw error;
    }
    await writeNextAction(context, noNextAction);
  }
  return 0;
}
