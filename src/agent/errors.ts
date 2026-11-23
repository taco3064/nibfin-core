export type AgentErrorCode =
  | "AGENT_RUN_FAILED"
  | "AGENT_LOGIN_REQUIRED"
  | "AGENT_CONFIG_GENERATION_FAILED"
  | "AGENT_CONFIG_INVALID";

export interface AgentErrorDetails {
  /** The CLI's own exit code; `null` when a signal ended it. */
  exitCode?: number | null;
  /** The command that renews the provider login. */
  loginCommand?: string;
  /** Output captured from a tool whose output is not streamed to the Job. */
  output?: string;
  cause?: unknown;
}

/** A failure that names its cause and keeps the tool's original exit code. */
export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly exitCode: number | null | undefined;
  readonly loginCommand: string | undefined;
  readonly output: string | undefined;

  constructor(code: AgentErrorCode, message: string, details: AgentErrorDetails) {
    super(message, { cause: details.cause });
    this.name = "AgentError";
    this.code = code;
    this.exitCode = details.exitCode;
    this.loginCommand = details.loginCommand;
    this.output = details.output;
  }
}
