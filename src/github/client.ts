import type { Octokit as CoreOctokit } from "@octokit/core";
import { retry, type RetryOptions } from "@octokit/plugin-retry";
import { throttling, type ThrottlingOptions } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { read } from "./errors.ts";
import { installReadCache, isReadRequest, sentRequest } from "./read-cache.ts";

/** The GitHub account Nibfin acts as: the owner of the token (`GET /user`). */
export interface Actor {
  id: number;
  login: string;
}

/** `@octokit/rest` with the official retry and throttling plugins. */
const NibfinOctokit = Octokit.plugin(retry, throttling);

/** What `createClient` returns. */
export type NibfinOctokit = InstanceType<typeof NibfinOctokit>;

/** What the modules of `src/github` need from Octokit. */
export type GitHubClient = Pick<Octokit, "request" | "paginate">;

/** A client that also knows the account it writes as. */
export type ActingClient = GitHubClient & { readonly actor: Actor };

type LimitHandlers = "onRateLimit" | "onSecondaryRateLimit";

/**
 * Octokit options a caller may add (tests pass their own `request.fetch`). `throttle`
 * and `retry` are merged with Nibfin's own settings; the rate-limit handlers stay.
 */
export type ClientOptions = Omit<
  NonNullable<ConstructorParameters<typeof Octokit>[0]>,
  "auth" | "throttle" | "retry"
> & {
  throttle?: Omit<Partial<ThrottlingOptions>, LimitHandlers>;
  retry?: RetryOptions;
};

/** Writes one line to the Job log. */
export type LogLine = (line: string) => void;

const noLog: LogLine = () => {};

/** Retries after a primary rate limit (REST `x-ratelimit-remaining: 0`, GraphQL). */
export const primaryRetries = 2;
/** Retries after a secondary rate limit. */
export const secondaryRetries = 4;

interface LimitedRequest {
  method: string;
  url: string;
}

/**
 * A throttling handler: logs the limit and the wait GitHub stated, and retries while
 * `retryCount < max`. The log names the method and the URL path only, never the query
 * string, the body or a header.
 */
function onLimit(kind: "primary" | "secondary", max: number, log: LogLine) {
  return (
    retryAfter: number,
    options: LimitedRequest,
    octokit: CoreOctokit,
    retryCount: number,
  ): boolean => {
    const { method, url } = sentRequest(octokit, options);
    const what = `GitHub ${kind} rate limit on ${method} ${new URL(url).pathname}`;
    if (retryCount < max) {
      log(`${what}: waiting ${retryAfter} s (retry ${retryCount + 1} of ${max})`);
      return true;
    }
    log(`${what}: not retrying after ${max} retries`);
    return false;
  };
}

function buildOctokit(
  token: string,
  options: ClientOptions,
  log: LogLine,
): NibfinOctokit {
  const octokit = new NibfinOctokit({
    userAgent: "nibfin-core",
    ...options,
    auth: token,
    throttle: {
      ...options.throttle,
      onRateLimit: onLimit("primary", primaryRetries, log),
      onSecondaryRateLimit: onLimit("secondary", secondaryRetries, log),
    } as ThrottlingOptions,
    retry: {
      ...options.retry,
      // Rate limits (403/429) belong to the throttling plugin alone.
      doNotRetry: [400, 401, 403, 404, 410, 422, 429, 451],
    },
  });
  // A write is never re-sent after a 5xx or no response: its outcome is re-read.
  octokit.hook.before("request", (request) => {
    const { method, url, body } = sentRequest(octokit, request);
    if (!isReadRequest(method, url, body)) {
      request.request = { ...request.request, retries: 0 };
    }
  });
  installReadCache(octokit);
  return octokit;
}

function withActor(octokit: NibfinOctokit, actor: Actor): NibfinOctokit & ActingClient {
  return Object.assign(octokit, {
    actor: Object.freeze({ id: actor.id, login: actor.login }),
  });
}

/**
 * An Octokit instance authenticated with `token`, carrying the `actor` it writes as.
 * The token is used only here; Octokit sends it as the `authorization` header and
 * redacts it from request errors.
 *
 * Rate limits: a primary or secondary rate limit waits the time GitHub states
 * (`retry-after`, or `x-ratelimit-reset` when `x-ratelimit-remaining` is 0) and
 * retries, logging each wait with `log`. Reads (GET, GraphQL queries) are also retried
 * on a 5xx or no response; writes are not. Reads are kept per Job (`freshReads`).
 */
export function createClient(
  token: string,
  actor: Actor,
  options: ClientOptions = {},
  log: LogLine = noLog,
): NibfinOctokit & ActingClient {
  return withActor(buildOctokit(token, options, log), actor);
}

/** The account a token belongs to, read with `GET /user` (#674). */
export async function readActor(client: GitHubClient): Promise<Actor> {
  const { data } = await read("read the token's user", () => client.request("GET /user"));
  return { id: Number(data.id), login: data.login };
}

/**
 * A client for `token` that writes as the token's own account, read once with
 * `GET /user` through the same instance; valid for a user's gh login token, not for
 * `GITHUB_TOKEN`.
 */
export async function connectClient(
  token: string,
  options: ClientOptions = {},
  log: LogLine = noLog,
): Promise<NibfinOctokit & ActingClient> {
  const octokit = buildOctokit(token, options, log);
  return withActor(octokit, await readActor(octokit));
}
