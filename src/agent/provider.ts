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
  rulesyncTarget: "codexcli",
  defaultModel: undefined,
  loginStatusArgs: ["login", "status"],
  headlessArgs: (model, lastMessageFile) => [
    "exec",
    "--json",
    "--trust",
    "--dangerously-bypass-approvals-and-sandbox",
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
