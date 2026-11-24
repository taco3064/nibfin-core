import { enableProjectMcpServers } from "./claude-settings.ts";
import { readOptionalFile } from "./fs.ts";
import {
  type AgentEvent,
  claudeResult,
  isClaudeLoginSignal,
  isCodexLoginSignal,
} from "./stream.ts";

export type Provider = "codex" | "claude";

export const providers: readonly Provider[] = ["codex", "claude"];

/** How Nibfin runs one provider CLI headless and reads its outcome. */
export interface ProviderSpec {
  readonly displayName: string;
  readonly executable: string;
  /** Points the CLI at its config home, where its own login lives. */
  readonly configHomeVariable: string;
  /**
   * Variables every run of this CLI gets on top of the allowlisted Job environment,
   * such as the switch that turns the CLI's auto memory off.
   */
  readonly runEnvironment: Readonly<Record<string, string>>;
  readonly rulesyncTarget: string;
  readonly defaultModel: string | undefined;
  readonly loginStatusArgs: readonly string[];
  headlessArgs(model: string | undefined, lastMessageFile: string): string[];
  isLoginSignal(event: AgentEvent): boolean;
  resultFromEvent(event: AgentEvent): string | undefined;
  readFinalMessage(
    streamResult: string | undefined,
    lastMessageFile: string,
  ): Promise<string | undefined>;
  /** Trusts project configuration in the config home before a run. */
  prepareHome(home: string): Promise<void>;
}

function modelArgs(flag: string, model: string | undefined): string[] {
  return model === undefined ? [] : [flag, model];
}

const claude: ProviderSpec = {
  displayName: "Claude Code",
  executable: "claude",
  configHomeVariable: "CLAUDE_CONFIG_DIR",
  // Roles share one config home, so nothing a run learns may carry into a later run.
  runEnvironment: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
  rulesyncTarget: "claudecode",
  defaultModel: "opus",
  loginStatusArgs: ["auth", "status"],
  headlessArgs: (model) => [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    ...modelArgs("--model", model),
  ],
  isLoginSignal: isClaudeLoginSignal,
  resultFromEvent: claudeResult,
  readFinalMessage: (streamResult) => Promise.resolve(streamResult),
  prepareHome: enableProjectMcpServers,
};

const codex: ProviderSpec = {
  displayName: "Codex",
  executable: "codex",
  configHomeVariable: "CODEX_HOME",
  runEnvironment: {},
  rulesyncTarget: "codexcli",
  defaultModel: undefined,
  loginStatusArgs: ["login", "status"],
  headlessArgs: (model, lastMessageFile) => [
    "exec",
    "--json",
    "--trust",
    "--dangerously-bypass-approvals-and-sandbox",
    // Auto memory off for this run only; the shared `config.toml` stays untouched.
    "-c",
    "features.memories=false",
    "-o",
    lastMessageFile,
    ...modelArgs("-m", model),
    "-",
  ],
  isLoginSignal: isCodexLoginSignal,
  resultFromEvent: () => undefined,
  readFinalMessage: (_streamResult, lastMessageFile) => readOptionalFile(lastMessageFile),
  // `--trust` saves project trust through Codex's own config editor.
  prepareHome: () => Promise.resolve(),
};

export const providerSpecs: Readonly<Record<Provider, ProviderSpec>> = { claude, codex };

/** The re-login command shown when a provider login is missing or expired. */
export function loginCommand(provider: Provider): string {
  return `gh nibfin login --provider ${provider}`;
}
