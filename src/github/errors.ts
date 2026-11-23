export type GitHubErrorCode =
  "GITHUB_READ_FAILED" | "GITHUB_WRITE_UNCONFIRMED" | "GITHUB_WRITE_REJECTED";

/**
 * A GitHub read or write that did not give a usable result. `cause` keeps the original
 * error (for an Octokit `RequestError`: its `status` and response headers, so rate limits
 * stay identifiable). The message names only the operation and the HTTP status.
 */
export class GitHubError extends Error {
  readonly code: GitHubErrorCode;
  readonly operation: string;

  constructor(code: GitHubErrorCode, operation: string, cause: unknown) {
    super(`${operation}: ${describe(code)} (${describeCause(cause)})`, { cause });
    this.name = "GitHubError";
    this.code = code;
    this.operation = operation;
  }
}

function describe(code: GitHubErrorCode): string {
  switch (code) {
    case "GITHUB_READ_FAILED":
      return "read failed";
    case "GITHUB_WRITE_UNCONFIRMED":
      return "write outcome unconfirmed";
    case "GITHUB_WRITE_REJECTED":
      return "write rejected";
  }
}

function describeCause(cause: unknown): string {
  if (hasResponse(cause)) {
    return `HTTP ${statusOf(cause)}`;
  }
  return "no response";
}

/** The HTTP status of an Octokit `RequestError`, if the error carries one. */
export function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const { status } = error;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

/**
 * True when GitHub answered: Octokit sets `response` on the error. A network failure is
 * a `RequestError` whose `response` field is present but undefined.
 */
export function hasResponse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    error.response !== undefined
  );
}

/** A write whose outcome is unknown: no response, or a server error. */
export function isUnknownOutcome(error: unknown): boolean {
  const status = statusOf(error);
  return !hasResponse(error) || status === undefined || status >= 500;
}

/** Runs a read; any failure becomes `GITHUB_READ_FAILED` with the original cause. */
export async function read<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw asReadError(operation, error);
  }
}

/** Runs a read where a 404 means "absent"; any other failure is `GITHUB_READ_FAILED`. */
export async function readOptional<T>(
  operation: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    if (hasResponse(error) && statusOf(error) === 404) {
      return undefined;
    }
    throw asReadError(operation, error);
  }
}

function asReadError(operation: string, error: unknown): GitHubError {
  if (error instanceof GitHubError) {
    return error;
  }
  return new GitHubError("GITHUB_READ_FAILED", operation, error);
}
