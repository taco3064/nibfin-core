import { AgentError, loginCommand, providerSpecs, runAgent } from "../agent/index.ts";
import {
  type NibfinConfig,
  prepareTools,
  readNibfinConfig,
  resolveRoleSkill,
} from "../config/index.ts";
import {
  type ActingClient,
  findMarkedComment,
  type IssueRef,
  upsertMarkedComment,
} from "../github/index.ts";
import type { JobContext } from "./context.ts";
import { composePrompt, type PromptSection, type StageRole } from "./prompt.ts";
import { readWorkspaceState, requireUnchanged } from "./workspace.ts";

/** The Issue comment that asks for a new agent login. */
export const loginCommentKey = "agent-login";

/** What the stages call out to; tests replace each with a fake. */
export interface StageDeps {
  runAgent: typeof runAgent;
  readNibfinConfig: typeof readNibfinConfig;
  resolveRoleSkill: typeof resolveRoleSkill;
  prepareTools: (
    tools: NibfinConfig["tools"],
    options: { workspace: string; cacheDir: string },
  ) => Promise<string[]>;
  /** One line of the Job log. */
  log: (line: string) => void;
}

export const defaultStageDeps: StageDeps = {
  runAgent,
  readNibfinConfig,
  resolveRoleSkill,
  prepareTools,
  log: (line) => process.stdout.write(`${line}\n`),
};

/** One Job: its context, client, `.nibfin.json` and tool `PATH` entries. */
export interface StageJob {
  readonly context: JobContext;
  readonly client: ActingClient;
  readonly deps: StageDeps;
  readonly config: NibfinConfig;
  readonly pathEntries: readonly string[];
  /** Whether a successful run has already settled the login comment. */
  loginSettled: boolean;
}

export function issueOf(context: JobContext): IssueRef {
  return { ...context.repo, number: context.issue };
}

/**
 * Reads `.nibfin.json` before any role runs (a `ConfigError` rejects the Job as is)
 * and installs its tools once for the Job.
 */
export async function prepareStageJob(
  context: JobContext,
  client: ActingClient,
  deps: StageDeps,
): Promise<StageJob> {
  const config = await deps.readNibfinConfig(context.workspace);
  const pathEntries = await deps.prepareTools(config.tools, {
    workspace: context.workspace,
    cacheDir: context.toolCache,
  });
  return { context, client, deps, config, pathEntries, loginSettled: false };
}

function loginBody(job: StageJob): string {
  const { provider } = job.context;
  const name = providerSpecs[provider].displayName;
  return [
    `Nibfin could not run the agent: the ${name} login is missing or expired.`,
    "",
    `Run \`${loginCommand(provider)}\` on the runner host, then run the stage again.`,
  ].join("\n");
}

const loginResolvedBody = "Resolved: the agent login works again.";

async function settleLoginComment(job: StageJob): Promise<void> {
  if (job.loginSettled) {
    return;
  }
  const issue = issueOf(job.context);
  if (await findMarkedComment(job.client, issue, loginCommentKey)) {
    await upsertMarkedComment(job.client, issue, loginCommentKey, loginResolvedBody);
  }
  job.loginSettled = true;
}

/**
 * Runs `role` once with the role's skill text and `sections`, and returns the agent's
 * final message. A read-only role must leave the workspace clean at the same `HEAD`.
 * A missing login is reported on the Issue before the error is rethrown.
 */
export async function runStageAgent(
  job: StageJob,
  role: StageRole,
  sections: readonly PromptSection[],
): Promise<string> {
  const { context, deps } = job;
  const skill = await deps.resolveRoleSkill(role.skill, job.config, {
    workspace: context.workspace,
  });
  const prompt = composePrompt({ skill, role, sections });
  const before = role.readOnly ? await readWorkspaceState(context.workspace) : undefined;
  if (before !== undefined) {
    requireUnchanged(before, role.title);
  }
  let finalMessage: string;
  try {
    ({ finalMessage } = await deps.runAgent({
      provider: context.provider,
      workspace: context.workspace,
      prompt,
      home: context.agentHome,
      ...(context.model === undefined ? {} : { model: context.model }),
      pathEntries: job.pathEntries,
    }));
  } catch (error) {
    if (error instanceof AgentError && error.code === "AGENT_LOGIN_REQUIRED") {
      const body = loginBody(job);
      await upsertMarkedComment(job.client, issueOf(context), loginCommentKey, body);
    }
    throw error;
  }
  await settleLoginComment(job);
  if (before !== undefined) {
    requireUnchanged(await readWorkspaceState(context.workspace), role.title, before);
  }
  return finalMessage;
}
