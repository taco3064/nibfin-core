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
  observation.result = spec.resultFromEvent(event) ?? observation.result;
}

async function loginStatusFails(spec: ProviderSpec, base: ProcessRequest) {
  const status = await runQuiet({ ...base, args: spec.loginStatusArgs });
  return status.exitCode === 1;
}

async function failure(
  provider: Provider,
  status: ExitStatus,
  loginSignal: boolean,
  base: ProcessRequest,
): Promise<AgentError> {
  const spec = providerSpecs[provider];
  const name = spec.displayName;
  const exit = describeExit(status);
  if (loginSignal || (await loginStatusFails(spec, base))) {
    const login = loginCommand(provider);
    const message = `${name} login is missing or expired (${exit}). Run: ${login}`;
    return new AgentError("AGENT_LOGIN_REQUIRED", message, {
      exitCode: status.exitCode,
      loginCommand: login,
    });
  }
  const message = `${name} failed with ${exit}; its output is in the log above`;
  return new AgentError("AGENT_RUN_FAILED", message, { exitCode: status.exitCode });
}

/**
 * The agent CLI's own process: with `pathEntries`, an absolute command (resolved on
 * the unmodified `PATH`) and those entries ahead of the inherited `PATH`.
 */
async function agentRequest(
  base: ProcessRequest,
  pathEntries: readonly string[],
): Promise<ProcessRequest> {
  if (pathEntries.length === 0) {
    return base;
  }
  const inherited = base.env.PATH;
  const command = await resolveCommand(base.command, base.cwd, inherited);
  const path = [...pathEntries, inherited].filter((entry) => entry !== undefined);
  return { ...base, command, env: { ...base.env, PATH: path.join(delimiter) } };
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
  const agent = await agentRequest(base, options.pathEntries ?? []);
  const lastMessageFile = await gitPath(workspace, "nibfin-last-message");
  await rm(lastMessageFile, { force: true });
  await options.beforeStart?.();
  try {
    const observation: Observation = { loginSignal: false, result: undefined };
    const status = await runStreaming({
      ...agent,
      args: spec.headlessArgs(options.model ?? spec.defaultModel, lastMessageFile),
      stdin: options.prompt,
      stdout: output.stdout,
      stderr: output.stderr,
      onLine: (line) => observe(spec, observation, line),
    });
    if (status.exitCode !== 0) {
      throw await failure(provider, status, observation.loginSignal, base);
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
