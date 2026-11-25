export type StageErrorCode =
  | "STAGE_INPUT_INVALID"
  | "STAGE_RESULT_INVALID"
  | "STAGE_BLOCKED"
  | "STAGE_WORKSPACE_MODIFIED"
  | "STAGE_WRITER_ACTIVE"
  | "STAGE_GIT_FAILED"
  | "STAGE_PUSH_REJECTED"
  | "STAGE_PROTECTED_PATH"
  | "STAGE_HOST_MEMORY_LOW"
  | "STAGE_NO_PROGRESS"
  | "STAGE_MULTIPLE_ASSIGNEES";

/** A stage that stopped for a named reason. `cause` keeps the original error, if any. */
export class StageError extends Error {
  readonly code: StageErrorCode;

  constructor(code: StageErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "StageError";
    this.code = code;
  }
}

/**
 * A stage that exited 0 without progress while the route still asks for the same
 * stage and reason (#674). `temporary` when waiting is likely to fix it (GitHub
 * still computing mergeability).
 */
export class NoProgressError extends StageError {
  readonly temporary: boolean;

  constructor(message: string, temporary: boolean) {
    super("STAGE_NO_PROGRESS", message);
    this.name = "NoProgressError";
    this.temporary = temporary;
  }
}
