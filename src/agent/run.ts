import { rm } from "node:fs/promises";
import { delimiter } from "node:path";
import { childEnvironment } from "./environment.ts";
import { AgentError } from "./errors.ts";
import { gitPath } from "./git-path.ts";
import { parseJsonRecord } from "./json.ts";
import {
  type ByteSink,
  type Command,
  describeExit,
  type ExitStatus,
  type ProcessRequest,
  runQuiet,
  runStreaming,
} from "./process.ts";
import {
  loginCommand,
  type Provider,
  providerSpecs,
  type ProviderSpec,
} from "./provider.ts";
import { resolveCommand } from "./resolve-command.ts";
import { generateAgentConfig } from "./rulesync.ts";
import type { UsageLimitReport } from "./stream.ts";

export type AgentExecutables = Record<Provider | "rulesync", Command>;

export interface RunAgentOptions {
  provider: Provider;
  /** The repository checkout the CLI works in. */
  workspace: string;
  /** Sent on stdin, never as an argument. */
  prompt: string;
  /** The CLI's config home on the login volume. */
  home: string;
  model?: string;
  /**
   * Prepended to the inherited `PATH` for the agent CLI's run only, so the agent's
   * tool processes find them. The CLI is first resolved to an absolute command on
   * the unmodified `PATH`; its login-status command and rulesync keep that `PATH`.
   */
  pathEntries?: readonly string[];
  /**
   * Extra variables for the agent CLI's run only, such as `PLAYWRIGHT_BROWSERS_PATH`.
   * They cannot override the inherited variables, the provider's own run variables
   * or its config-home variable; the login-status command and rulesync do not
   * receive them.
   */
  environment?: Readonly<Record<string, string>>;
  /**
   * Called after rulesync has generated the agent config and right before the CLI
   * starts, so a caller can record the workspace the CLI will see. A rejection stops
   * the run before the CLI starts.
   */
  beforeStart?: () => Promise<void>;
  executables?: Partial<AgentExecutables>;
  /** Where the CLI's own output is forwarded; the process streams by default. */
  output?: { stdout: ByteSink; stderr: ByteSink };
}

export interface AgentResult {
  exitCode: number;
  finalMessage: string;
}

export const defaultExecutables: AgentExecutables = {
  claude: { command: providerSpecs.claude.executable, args: [] },
  codex: { command: providerSpecs.codex.executable, args: [] },
  rulesync: { command: "rulesync", args: [] },
};

interface Observation {
  loginSignal: boolean;
  /** The latest usage-limit report; a later `allowed` clears an earlier rejection. */
  usageLimit: UsageLimitReport | undefined;
  result: string | undefined;
}

function observe(spec: ProviderSpec, observation: Observation, line: string): void {
  const event = parseJsonRecord(line);
  if (event === undefined) {
    return;
  }
  if (spec.isLoginSignal(event)) {
    observation.loginSignal = true;
  }
  observation.usageLimit = spec.usageLimitFromEvent(event) ?? observation.usageLimit;
  observation.result = spec.resultFromEvent(event) ?? observation.result;
}

async function loginStatusFails(spec: ProviderSpec, base: ProcessRequest) {
  const status = await runQuiet({ ...base, args: spec.loginStatusArgs });
  return status.exitCode === 1;
}

function loginRequired(provider: Provider, status: ExitStatus): AgentError {
  const name = providerSpecs[provider].displayName;
  const login = loginCommand(provider);
  const exit = describeExit(status);
  const message = `${name} login is missing or expired (${exit}). Run: ${login}`;
  return new AgentError("AGENT_LOGIN_REQUIRED", message, {
    exitCode: status.exitCode,
    loginCommand: login,
  });
}

function usageLimitReached(
  provider: Provider,
  status: ExitStatus,
  report: UsageLimitReport,
): AgentError {
  const name = providerSpecs[provider].displayName;
  const limit = report.type === undefined ? "its" : `its ${report.type}`;
  const exit = describeExit(status);
  const { reset } = report;
  const message =
    reset === undefined
      ? `${name} stopped at ${limit} usage limit (${exit}); the CLI did not report ` +
        "when it resets. Remove the pending label after the limit resets to continue."
      : `${name} stopped at ${limit} usage limit (${exit}); it resets at ${reset}. ` +
        "Remove the pending label after that time to continue.";
  return new AgentError("AGENT_USAGE_LIMIT", message, {
    exitCode: status.exitCode,
    ...(reset === undefined ? {} : { usageLimitReset: reset }),
  });
}

async function failure(
  provider: Provider,
  status: ExitStatus,
  observation: Observation,
  base: ProcessRequest,
): Promise<AgentError> {
  const spec = providerSpecs[provider];
  const name = spec.displayName;
  const exit = describeExit(status);
  if (observation.loginSignal) {
    return loginRequired(provider, status);
  }
  // Known before the login-status command, so that command does not run for it.
  if (observation.usageLimit?.rejected === true) {
    return usageLimitReached(provider, status, observation.usageLimit);
  }
  if (await loginStatusFails(spec, base)) {
    return loginRequired(provider, status);
  }
  const message = `${name} failed with ${exit}; its output is in the log above`;
  return new AgentError("AGENT_RUN_FAILED", message, { exitCode: status.exitCode });
}

/**
 * The agent CLI's own process: `environment` below the base variables and, with
 * `pathEntries`, an absolute command (resolved on the unmodified `PATH`) and those
 * entries ahead of the inherited `PATH`.
 */
async function agentRequest(
  base: ProcessRequest,
  pathEntries: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<ProcessRequest> {
  const request = { ...base, env: { ...environment, ...base.env } };
  if (pathEntries.length === 0) {
    return request;
  }
  const inherited = base.env.PATH;
  const command = await resolveCommand(base.command, base.cwd, inherited);
  const path = [...pathEntries, inherited].filter((entry) => entry !== undefined);
  return { ...request, command, env: { ...request.env, PATH: path.join(delimiter) } };
}

/**
 * Runs the provider CLI headless in the workspace with the repository's agent
 * config and the CLI's own login, and returns its final message.
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const { provider, workspace, home } = options;
  const spec = providerSpecs[provider];
  const executables = { ...defaultExecutables, ...options.executables };
  const output = { stdout: process.stdout, stderr: process.stderr, ...options.output };
  await generateAgentConfig({
    workspace,
    target: spec.rulesyncTarget,
    rulesync: executables.rulesync,
  });
  await spec.prepareHome(home);
  const base: ProcessRequest = {
    command: executables[provider],
    args: [],
    cwd: workspace,
    env: childEnvironment(process.env, {
      ...spec.runEnvironment,
      [spec.configHomeVariable]: home,
    }),
  };
  const agent = await agentRequest(
    base,
    options.pathEntries ?? [],
    options.environment ?? {},
  );
  const lastMessageFile = await gitPath(workspace, "nibfin-last-message");
  await rm(lastMessageFile, { force: true });
  await options.beforeStart?.();
  try {
    const observation: Observation = {
      loginSignal: false,
      usageLimit: undefined,
      result: undefined,
    };
    const status = await runStreaming({
      ...agent,
      args: spec.headlessArgs(options.model ?? spec.defaultModel, lastMessageFile),
      stdin: options.prompt,
      stdout: output.stdout,
      stderr: output.stderr,
      onLine: (line) => observe(spec, observation, line),
    });
    if (status.exitCode !== 0) {
      throw await failure(provider, status, observation, base);
    }
    const finalMessage = await spec.readFinalMessage(observation.result, lastMessageFile);
    if (finalMessage === undefined) {
      const message = `${spec.displayName} exited 0 without a final message`;
      throw new AgentError("AGENT_RUN_FAILED", message, { exitCode: 0 });
    }
    return { exitCode: 0, finalMessage };
  } finally {
    await rm(lastMessageFile, { force: true });
  }
}
