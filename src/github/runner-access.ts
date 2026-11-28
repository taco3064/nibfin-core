// What a runner request needs from GitHub (#776): the requester's SSH keys, a
// read-only deploy key and a runner registration token. The runner request
// (`src/runner-request`) decides when to use them.
import type { GitHubClient } from "./client.ts";
import { read } from "./errors.ts";
import type { Repo } from "./repo.ts";
import { write } from "./write.ts";

/** A public SSH key of a GitHub account. */
export interface UserKey {
  id: number;
  /** The key as GitHub lists it: `<type> <base64>`. */
  key: string;
}

/** The public SSH keys of the account `login`, all pages (`GET /users/{login}/keys`). */
export async function readUserKeys(
  client: GitHubClient,
  login: string,
): Promise<UserKey[]> {
  const keys = await read(`list the SSH keys of ${login}`, () =>
    client.paginate("GET /users/{username}/keys", { username: login, per_page: 100 }),
  );
  return keys.map(({ id, key }) => ({ id, key }));
}

/** A deploy key of a repository. */
export interface DeployKey {
  id: number;
  readOnly: boolean;
}

/** The base64 part of a public key `<type> <base64> [comment]`. */
function keyBlob(key: string): string | undefined {
  return key.split(" ")[1];
}

/** The deploy key of `repo` whose key blob equals the blob of `key`, all pages. */
async function findDeployKey(
  client: GitHubClient,
  repo: Repo,
  key: string,
): Promise<DeployKey | undefined> {
  const blob = keyBlob(key);
  const keys = await read(`list the deploy keys of ${repo.owner}/${repo.repo}`, () =>
    client.paginate("GET /repos/{owner}/{repo}/keys", { ...repo, per_page: 100 }),
  );
  const found = keys.find((candidate) => keyBlob(candidate.key) === blob);
  return found === undefined ? undefined : { id: found.id, readOnly: found.read_only };
}

/**
 * Adds `key` as a read-only deploy key titled `title` to `repo` through `write()`.
 * Its confirm lists the deploy keys and matches the key blob, so a key that is
 * already a deploy key of `repo`, also one an earlier attempt added, is success.
 * Returns the deploy key and whether this call added it.
 */
export async function addDeployKey(
  client: GitHubClient,
  repo: Repo,
  title: string,
  key: string,
): Promise<DeployKey & { added: boolean }> {
  return write<DeployKey & { added: boolean }>(
    client,
    `add a deploy key to ${repo.owner}/${repo.repo}`,
    async () => {
      const { data } = await client.request("POST /repos/{owner}/{repo}/keys", {
        ...repo,
        title,
        key,
        read_only: true,
      });
      return { id: data.id, readOnly: data.read_only, added: true };
    },
    {
      confirm: async () => {
        const found = await findDeployKey(client, repo, key);
        return found === undefined ? undefined : { ...found, added: false };
      },
    },
  );
}

/** A runner registration token and when it expires, as GitHub answered. */
export interface RegistrationToken {
  token: string;
  expiresAt: string;
}

/**
 * Creates a runner registration token for `repo`
 * (`POST /repos/{owner}/{repo}/actions/runners/registration-token`). A token cannot
 * be confirmed by a re-read and a new one per send is harmless (each expires unused),
 * so any failure is re-sent without a pre-read up to `maxRetries` times.
 */
export async function createRegistrationToken(
  client: GitHubClient,
  repo: Repo,
): Promise<RegistrationToken> {
  return write(
    client,
    `create a runner registration token for ${repo.owner}/${repo.repo}`,
    async () => {
      const { data } = await client.request(
        "POST /repos/{owner}/{repo}/actions/runners/registration-token",
        { ...repo },
      );
      return { token: data.token, expiresAt: data.expires_at };
    },
    { confirm: () => Promise.resolve(undefined) },
  );
}
