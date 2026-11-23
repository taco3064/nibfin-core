import { Octokit } from "@octokit/rest";

/** The GitHub account Nibfin acts as; supplied by the caller (#674). */
export interface Actor {
  id: number;
  login: string;
}

/** What the modules of `src/github` need from Octokit. */
export type GitHubClient = Pick<Octokit, "request" | "paginate">;

/** A client that also knows the account it writes as. */
export type ActingClient = GitHubClient & { readonly actor: Actor };

/**
 * An Octokit instance authenticated with `token`, carrying the `actor` it writes as.
 * The token is used only here; Octokit sends it as the `authorization` header and
 * redacts it from request errors. No retry or timeout is added.
 */
export function createClient(token: string, actor: Actor): Octokit & ActingClient {
  const octokit = new Octokit({ auth: token, userAgent: "nibfin-core" });
  return Object.assign(octokit, {
    actor: Object.freeze({ id: actor.id, login: actor.login }),
  });
}
