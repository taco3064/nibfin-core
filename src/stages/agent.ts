import { join } from "node:path";
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
  freshReads,
  type IssueRef,
  upsertMarkedComment,
} from "../github/index.ts";
import type { JobContext } from "./context.ts";
import { StageError } from "./errors.ts";
import { checkHostMemory, readMeminfo } from "./host-memory.ts";
import { composePrompt, type PromptSection, type StageRole } from "./prompt.ts";
import {
  readWorkspaceState,
  requireClean,
  requireSame,
  type WorkspaceState,
} from "./workspace.ts";

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
  /** The host's `/proc/meminfo` text, for the memory check (#674). */
  readMeminfo: () => Promise<string>;
  /** One line of the Job log. */
  log: (line: string) => void;
}

export const defaultStageDeps: StageDeps = {
  runAgent,
  readNibfinConfig,
  resolveRoleSkill,
  prepareTools,
  readMeminfo,
  log: (line) => process.stdout.write(`${line}\n`),
};

/**
 * One Job: its context, client, `.nibfin.json`, tool `PATH` entries and the extra
 * variables for the agent CLI's run.
 */
export interface StageJob {
  readonly context: JobContext;
  readonly client: ActingClient;
  readonly deps: StageDeps;
  readonly config: NibfinConfig;
  readonly pathEntries: readonly string[];
  /** `PLAYWRIGHT_BROWSERS_PATH` in the tool cache, so browser downloads persist. */
  readonly environment: Readonly<Record<string, string>>;
  /** Whether a successful run has already settled the login comment. */
  loginSettled: boolean;
}

export function issueOf(context: JobContext): IssueRef {
  return { ...context.repo, number: context.issue };
}

/**
 * Right before a stage's first agent run: checks the host's available memory
 * (`STAGE_HOST_MEMORY_LOW`), reads `.nibfin.json` (a `ConfigError` rejects the Job as
 * is) and installs its tools once for the Job. Playwright's browser downloads go to
 * `ms-playwright` in the tool cache.
 */
export async function prepareStageJob(
  context: JobContext,
  client: ActingClient,
  deps: StageDeps,
): Promise<StageJob> {
  await checkHostMemory(context.memoryRequired, deps.readMeminfo);
  const config = await deps.readNibfinConfig(context.workspace);
  const pathEntries = await deps.prepareTools(config.tools, {
    workspace: context.workspace,
    cacheDir: context.toolCache,
  });
  const environment = {
    PLAYWRIGHT_BROWSERS_PATH: join(context.toolCache, "ms-playwright"),
  };
  return { context, client, deps, config, pathEntries, environment, loginSettled: false };
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
 * final message. A read-only role must start in a workspace without changes and leave
 * it exactly as recorded right before the CLI started (same `HEAD`, same entries,
 * ignored files included).
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
  // GitHub may change while the agent runs; reads before and after it go to GitHub.
  freshReads(job.client);
  // Recorded after rulesync generated its files, right before the CLI starts.
  let before: WorkspaceState | undefined;
  const recordWorkspace = async () => {
    before = await readWorkspaceState(context.workspace);
    requireClean(before, role.title);
  };
  let finalMessage: string;
  try {
    ({ finalMessage } = await deps.runAgent({
      provider: context.provider,
      workspace: context.workspace,
      prompt,
      home: context.agentHome,
      ...(context.model === undefined ? {} : { model: context.model }),
      pathEntries: job.pathEntries,
      environment: job.environment,
      ...(role.readOnly ? { beforeStart: recordWorkspace } : {}),
    }));
  } catch (error) {
    freshReads(job.client);
    if (error instanceof AgentError && error.code === "AGENT_LOGIN_REQUIRED") {
      const body = loginBody(job);
      await upsertMarkedComment(job.client, issueOf(context), loginCommentKey, body);
    }
    throw error;
  }
  freshReads(job.client);
  await settleLoginComment(job);
  if (role.readOnly) {
    if (before === undefined) {
      const message = `The workspace was not recorded before ${role.title} started`;
      throw new StageError("STAGE_WORKSPACE_MODIFIED", message);
    }
    requireSame(before, await readWorkspaceState(context.workspace), role.title);
  }
  return finalMessage;
}
