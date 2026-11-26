import { setTimeout as sleep } from "node:timers/promises";
import type { Octokit } from "@octokit/core";
import { GitHubError, hasResponse, rateLimitOf, statusOf } from "./errors.ts";
import { isReadRequest, retrySettingsOf, sentRequest } from "./read-cache.ts";

/**
 * Retries of one GitHub API call after its first attempt (Proposal R4.37): the same
 * for every call and every error.
 */
export const maxRetries = 3;

/** Writes one line to the Job log. */
export type LogLine = (line: string) => void;

/** Waits `seconds` inside the running call (no timer outlives it, R1.15). */
export type Wait = (seconds: number) => Promise<void>;

export const realWait: Wait = (seconds) => sleep(seconds * 1000);

/** Seconds a secondary rate limit waits when GitHub states no `retry-after`. */
const secondaryFallback = 60;

function headerOf(error: unknown, name: string): number {
  const { response } = error as { response: { headers?: Record<string, unknown> } };
  return Number(response.headers?.[name]);
}

/** The original error of a `GitHubError`; any other value as it is. */
function causeOf(error: unknown): unknown {
  return error instanceof GitHubError ? error.cause : error;
}

/**
 * The seconds to wait before retry `k` (1 to `maxRetries`) after `error`: a secondary
 * rate limit waits `retry-after` (60 s without it), a primary one until
 * `x-ratelimit-reset` plus 1 s (60 s without it), anything else `k²` seconds.
 */
export function retryDelay(error: unknown, k: number, now = Date.now()): number {
  const cause = causeOf(error);
  const limit = rateLimitOf(cause);
  if (limit === "secondary") {
    const retryAfter = headerOf(cause, "retry-after");
    return retryAfter > 0 ? retryAfter : secondaryFallback;
  }
  if (limit === "primary") {
    const reset = headerOf(cause, "x-ratelimit-reset");
    if (!Number.isFinite(reset)) {
      return secondaryFallback;
    }
    return Math.max(Math.ceil(reset - now / 1000) + 1, 0);
  }
  return k * k;
}

/**
 * What failed, for the Job log: the rate-limit kind, `no response`, `GraphQL error`
 * or the HTTP status. Never a message, header or body.
 */
export function retryCause(error: unknown): string {
  const cause = causeOf(error);
  const limit = rateLimitOf(cause);
  if (limit !== undefined) {
    return `${limit} rate limit`;
  }
  if (!hasResponse(cause)) {
    return "no response";
  }
  const status = statusOf(cause);
  return status === undefined ? "GraphQL error" : `HTTP ${status}`;
}

/**
 * `GitHub <method> <path>` of the request an Octokit error carries (the path only,
 * never the query string), or `fallback` when it carries none.
 */
export function requestName(error: unknown, fallback: string): string {
  const request = (causeOf(error) as { request?: { method?: unknown; url?: unknown } })
    ?.request;
  if (typeof request?.method !== "string" || typeof request.url !== "string") {
    return fallback;
  }
  return `GitHub ${request.method} ${new URL(request.url).pathname}`;
}

/** The Job-log line when a call gives up. */
export function giveUpLine(what: string, cause: string): string {
  return `${what}: ${cause}; not retrying after ${maxRetries} retries`;
}

async function announceAndWait(
  settings: { log: LogLine; wait: Wait },
  what: string,
  error: unknown,
  k: number,
  cause: string,
): Promise<void> {
  const seconds = retryDelay(error, k);
  settings.log(`${what} (retry ${k} of ${maxRetries}): ${cause}; waiting ${seconds} s`);
  await settings.wait(seconds);
}

/**
 * Logs retry `k` of `what` with `cause` and waits `retryDelay(error, k)` with the
 * client's log and wait (a client without them logs nothing and waits for real).
 * Returns the client's log.
 */
export async function waitToRetry(
  client: object,
  what: string,
  error: unknown,
  k: number,
  cause = retryCause(error),
): Promise<LogLine> {
  const settings = retrySettingsOf(client);
  await announceAndWait(settings, what, error, k, cause);
  return settings.log;
}

/** A GraphQL answer whose `errors` is a non-empty list. */
function hasGraphqlErrors(data: unknown): boolean {
  const errors = (Object(data) as { errors?: unknown }).errors;
  return Array.isArray(errors) && errors.length > 0;
}

type Response = Awaited<ReturnType<Octokit["request"]>>;

/** One read attempt: a usable answer, or why it failed (and the answer, if any). */
type ReadAttempt =
  | { ok: true; response: Response }
  | { ok: false; error: unknown; cause: string; response?: Response };

/**
 * Retries every read (GET, HEAD, GraphQL query) on any error up to `maxRetries`
 * times, logging each retry and waiting `retryDelay`. A GraphQL answer with `errors`
 * counts as an error; after the last retry it is returned as it is. A 404 of a request
 * sent with `request: { absent404: true }` is an answer ("absent") and is not retried.
 * Writes pass through; `write()` retries them. Install it before the read cache, so
 * identical reads still share one answer.
 */
export function installReadRetries(octokit: Octokit, log: LogLine, wait: Wait): void {
  octokit.hook.wrap("request", async (request, options) => {
    const { method, url, body } = sentRequest(octokit, options);
    if (!isReadRequest(method, url, body)) {
      return request(options);
    }
    const what = `GitHub ${method} ${new URL(url).pathname}`;
    const absent404 =
      (Object(options.request) as { absent404?: unknown }).absent404 === true;
    const attempt = async (): Promise<ReadAttempt> => {
      try {
        const response = await request(options);
        return hasGraphqlErrors(response.data)
          ? { ok: false, error: undefined, cause: "GraphQL error", response }
          : { ok: true, response };
      } catch (error) {
        if (absent404 && statusOf(error) === 404) {
          throw error;
        }
        return { ok: false, error, cause: retryCause(error) };
      }
    };
    for (let k = 1; k <= maxRetries; k += 1) {
      const result = await attempt();
      if (result.ok) {
        return result.response;
      }
      await announceAndWait({ log, wait }, what, result.error, k, result.cause);
    }
    const last = await attempt();
    if (last.ok) {
      return last.response;
    }
    log(giveUpLine(what, last.cause));
    if (last.response !== undefined) {
      return last.response;
    }
    throw last.error;
  });
}
