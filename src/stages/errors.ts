export type StageErrorCode =
  | "STAGE_INPUT_INVALID"
  | "STAGE_RESULT_INVALID"
  | "STAGE_BLOCKED"
  | "STAGE_WORKSPACE_MODIFIED";

/** A stage that stopped for a named reason. `cause` keeps the original error, if any. */
export class StageError extends Error {
  readonly code: StageErrorCode;

  constructor(code: StageErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "StageError";
    this.code = code;
  }
}
