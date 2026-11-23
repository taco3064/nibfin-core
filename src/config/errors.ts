export type ConfigErrorCode =
  "CONFIG_INVALID" | "CONFIG_SKILL_PATH_INVALID" | "TOOL_INSTALL_FAILED";

/**
 * A `.nibfin.json` that rejects the Job: an invalid file, an unsafe skill path or a
 * tool that could not be installed. `cause` keeps the original error, if any.
 */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode;

  constructor(code: ConfigErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ConfigError";
    this.code = code;
  }
}

/** The message of any thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
