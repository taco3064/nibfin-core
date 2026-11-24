import { Octokit } from "@octokit/rest";
import { read } from "./errors.ts";

/** The GitHub account Nibfin acts as: the owner of the token (`GET /user`). */
export interface Actor {
  id: number;
  login: string;
}

/** What the modules of `src/github` need from Octokit. */
export type GitHubClient = Pick<Octokit, "request" | "paginate">;

/** A client that also knows the account it writes as. */
export type ActingClient = GitHubClient & { readonly actor: Actor };

/** Octokit options a caller may add (tests pass their own `request.fetch`). */
export type ClientOptions = Omit<
  NonNullable<ConstructorParameters<typeof Octokit>[0]>,
  "auth"
>;

/**
 * An Octokit instance authenticated with `token`, carrying the `actor` it writes as.
 * The token is used only here; Octokit sends it as the `authorization` header and
 * redacts it from request errors. No retry or timeout is added.
 */
export function createClient(
  token: string,
  actor: Actor,
  options: ClientOptions = {},
): Octokit & ActingClient {
  const octokit = new Octokit({ userAgent: "nibfin-core", ...options, auth: token });
  return Object.assign(octokit, {
    actor: Object.freeze({ id: actor.id, login: actor.login }),
  });
}

/** The account a token belongs to, read with `GET /user` (#674). */
export async function readActor(client: GitHubClient): Promise<Actor> {
  const { data } = await read("read the token's user", () => client.request("GET /user"));
  return { id: Number(data.id), login: data.login };
}

/**
 * A client for `token` that writes as the token's own account, read once with
 * `GET /user`; valid for a user's gh login token, not for `GITHUB_TOKEN`.
 */
export async function connectClient(
  token: string,
  options: ClientOptions = {},
): Promise<Octokit & ActingClient> {
  const reader = new Octokit({ userAgent: "nibfin-core", ...options, auth: token });
  return createClient(token, await readActor(reader), options);
}
