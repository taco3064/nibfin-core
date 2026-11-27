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

/**
 * The cause of a read whose answer arrived but failed Nibfin's check that it is
 * complete (a missing node, a count mismatch, no `data`). Its message keeps the detail,
 * such as `Read 1 of 2 dependencies`. `retryIncomplete` retries it (Proposal R4.37).
 */
export class IncompleteAnswer extends Error {
  constructor(what: string) {
    super(what);
    this.name = "IncompleteAnswer";
  }
}

/** `GITHUB_READ_FAILED` of `operation` whose answer was incomplete (`what`). */
export function incompleteRead(operation: string, what: string): GitHubError {
  return new GitHubError("GITHUB_READ_FAILED", operation, new IncompleteAnswer(what));
}

/** True for a `GitHubError` whose cause is an `IncompleteAnswer`. */
export function isIncompleteRead(error: unknown): error is GitHubError {
  return error instanceof GitHubError && error.cause instanceof IncompleteAnswer;
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
  if (cause instanceof IncompleteAnswer) {
    return "incomplete answer";
  }
  if (!hasResponse(cause)) {
    return "no response";
  }
  const status = statusOf(cause);
  const limit = rateLimitOf(cause);
  const answer = status === undefined ? "GraphQL" : `HTTP ${status}`;
  return limit === undefined ? answer : `${answer}, rate limited (${limit})`;
}

export type RateLimit = "primary" | "secondary";

/**
 * The rate limit GitHub answered with, if any: a 403/429 with
 * `x-ratelimit-remaining: 0` or a GraphQL `RATE_LIMITED` error is primary; a message
 * about a secondary rate limit is secondary. The throttling plugin throws a GraphQL
 * rate limit as an error with the response but no status.
 */
export function rateLimitOf(error: unknown): RateLimit | undefined {
  if (!hasResponse(error)) {
    return undefined;
  }
  const { response, message } = error as {
    response: { headers?: Record<string, unknown>; data?: unknown };
    message?: unknown;
  };
  const status = statusOf(error);
  if (/\bsecondary rate\b/i.test(String(message))) {
    return "secondary";
  }
  const limited = status === 403 || status === 429;
  if (limited && response.headers?.["x-ratelimit-remaining"] === "0") {
    return "primary";
  }
  const errors = (response.data as { errors?: unknown } | undefined)?.errors;
  const graphql = Array.isArray(errors) ? (errors as Array<{ type?: unknown }>) : [];
  return graphql.some((item) => item?.type === "RATE_LIMITED") ? "primary" : undefined;
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

/**
 * The request option of a read whose 404 means "absent" (pass it as `request`): that
 * 404 is an answer, so the client does not retry it (Proposal R4.39). Octokit does not
 * send it.
 */
export const absentProbe = Object.freeze({ absent404: true });

/**
 * Runs a read where a 404 means "absent"; any other failure is `GITHUB_READ_FAILED`.
 * Its request carries `request: absentProbe`, so that 404 is not retried.
 */
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

/** The `message` GitHub answered with, if the error carries a response that has one. */
export function responseMessage(error: unknown): string | undefined {
  if (!hasResponse(error)) {
    return undefined;
  }
  const { response } = error as { response: { data?: unknown } };
  const data = response.data as { message?: unknown } | undefined;
  return typeof data?.message === "string" ? data.message : undefined;
}
