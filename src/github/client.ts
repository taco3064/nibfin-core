import { throttling, type ThrottlingOptions } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { read } from "./errors.ts";
import { installReadCache } from "./read-cache.ts";
import { installReadRetries, type LogLine, realWait, type Wait } from "./retry.ts";

export { maxRetries, retryDelay, type LogLine, type Wait } from "./retry.ts";

/** The GitHub account Nibfin acts as: the owner of the token (`GET /user`). */
export interface Actor {
  id: number;
  login: string;
}

/** `@octokit/rest` with the official throttling plugin. */
const NibfinOctokit = Octokit.plugin(throttling);

/** What `createClient` returns. */
export type NibfinOctokit = InstanceType<typeof NibfinOctokit>;

/** What the modules of `src/github` need from Octokit. */
export type GitHubClient = Pick<Octokit, "request" | "paginate">;

/** A client that also knows the account it writes as. */
export type ActingClient = GitHubClient & { readonly actor: Actor };

type LimitHandlers = "onRateLimit" | "onSecondaryRateLimit";

/**
 * Octokit options a caller may add (tests pass their own `request.fetch`). `throttle`
 * is merged with Nibfin's own settings; the rate-limit handlers stay. `wait` replaces
 * the wait before a retry (tests make it instant).
 */
export type ClientOptions = Omit<
  NonNullable<ConstructorParameters<typeof Octokit>[0]>,
  "auth" | "throttle"
> & {
  throttle?: Omit<Partial<ThrottlingOptions>, LimitHandlers>;
  wait?: Wait;
};

const noLog: LogLine = () => {};

/** The throttling plugin never retries by itself: every retry is Nibfin's (R4.37). */
const noPluginRetry = () => false;

function buildOctokit(
  token: string,
  options: ClientOptions,
  log: LogLine,
): NibfinOctokit {
  const { wait = realWait, ...octokitOptions } = options;
  const octokit = new NibfinOctokit({
    userAgent: "nibfin-core",
    ...octokitOptions,
    auth: token,
    throttle: {
      ...octokitOptions.throttle,
      onRateLimit: noPluginRetry,
      onSecondaryRateLimit: noPluginRetry,
    } as ThrottlingOptions,
  });
  // Installed first, so it runs inside the read cache: one retry loop per sent read.
  installReadRetries(octokit, log, wait);
  installReadCache(octokit, { log, wait });
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
 * Retries (Proposal R4.37–R4.39): a read (GET, GraphQL query) that fails with any
 * error, including a GraphQL `errors` answer, is retried up to `maxRetries` times,
 * except a 404 sent with `request: { absent404: true }`; writes are retried by
 * `write()` after a pre-read. A read whose answer arrived but is incomplete (a missing
 * node or count) is retried at call level by `retryIncomplete`, with fresh reads.
 * Each retry waits `retryDelay` (a rate limit the time GitHub states) and is logged
 * with `log`. The throttling plugin only spaces writes and reports GraphQL rate
 * limits. Reads are kept per Job (`freshReads`).
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

/** The account `login`, read with `GET /users/{login}`. */
export async function readUser(client: GitHubClient, login: string): Promise<Actor> {
  const { data } = await read(`read the user ${login}`, () =>
    client.request("GET /users/{username}", { username: login }),
  );
  return { id: Number(data.id), login: data.login };
}

/**
 * A client for `token` that writes as the account `login`, read once with
 * `GET /users/{login}` through the same instance. For a token whose account
 * `GET /user` cannot read, such as a job's `GITHUB_TOKEN`, which writes as
 * `github-actions[bot]`.
 */
export async function connectAs(
  token: string,
  login: string,
  options: ClientOptions = {},
  log: LogLine = noLog,
): Promise<NibfinOctokit & ActingClient> {
  const octokit = buildOctokit(token, options, log);
  return withActor(octokit, await readUser(octokit, login));
}
