// The answer to a runner request (#776, R5.59–R5.62): the Action's `runner-request`
// command on a GitHub-hosted runner. Two clients: the job token's client (writing as
// `github-actions[bot]`, the only author gh-nibfin accepts) reads the request and
// writes the answer over REST Issues endpoints only; the Nibfin token's client reads
// the author's permission, adds the deploy key and creates the registration token.
import type { ActingClient, GitHubClient, LogLine } from "../github/client.ts";
import { closeIssueNotPlanned, readIssueState } from "../github/issue-state.ts";
import { isWritePermission, readCollaboratorPermission } from "../github/pull-request.ts";
import { formatIssue, type IssueRef, type Repo } from "../github/repo.ts";
import {
  addDeployKey,
  createRegistrationToken,
  readUserKeys,
} from "../github/runner-access.ts";
import { upsertMarkedComment } from "../github/writes.ts";
import { describeFailure } from "../stages/pending.ts";
import type { Age } from "./age.ts";
import {
  failedRefusal,
  refusalBody,
  refusedKey,
  registrationBody,
  registrationKey,
} from "./answers.ts";
import {
  checkKey,
  checkRequest,
  keyType,
  permissionRefusal,
  type Refusal,
  requestMarker,
  type RequestIssue,
} from "./check.ts";

export interface RunnerRequestInput {
  /** The repository the request was opened in (`GITHUB_REPOSITORY`). */
  repo: Repo;
  issue: RequestIssue;
  /** This workflow run's URL, named in a failed answer. */
  url: string | undefined;
}

export interface RunnerRequestDeps {
  /** The job token's client, writing as `github-actions[bot]`. */
  job: ActingClient;
  /** Connects the Nibfin token's client; called only once the body checks passed. */
  connect: () => Promise<GitHubClient>;
  age: Age;
  log: LogLine;
}

/** What a request ended with. */
export type RequestOutcome = "not-a-request" | "not-open" | "refused" | "answered";

type Answer = { kind: "refused"; refusal: Refusal } | { kind: "answered"; body: string };

/** The answer of a request that passed the body checks, or why it is refused. */
async function prepare(
  input: RunnerRequestInput,
  deps: RunnerRequestDeps,
  checked: { keyId: string; deployKey: string | undefined },
): Promise<Answer> {
  const { repo, issue } = input;
  const { login } = issue;
  const { keyId, deployKey } = checked;
  const name = `${repo.owner}/${repo.repo}`;
  const nibfin = await deps.connect();
  const permission = await readCollaboratorPermission(nibfin, repo, login);
  if (!isWritePermission(permission)) {
    return { kind: "refused", refusal: permissionRefusal(login, permission, repo) };
  }
  const keys = await readUserKeys(deps.job, login);
  const key = keys.find((candidate) => String(candidate.id) === keyId)?.key;
  const keyRefusal = checkKey(login, keyId, key);
  if (keyRefusal !== undefined) {
    return { kind: "refused", refusal: keyRefusal };
  }
  deps.log(`Request of ${login} for the SSH key ${keyId} (${keyType(key!)})`);
  // Before any write: without age no deploy key or token is created.
  await deps.age.check();
  if (deployKey !== undefined) {
    const title = `nibfin-runner-${login}`;
    deps.log("The request has a deploy key");
    const added = await addDeployKey(nibfin, repo, title, deployKey);
    deps.log(
      added.added
        ? `Added the read-only deploy key ${title} to ${name} (id ${added.id})`
        : `The key is already a deploy key of ${name} ` +
            `(id ${added.id}, read_only ${added.readOnly})`,
    );
  }
  const token = await createRegistrationToken(nibfin, repo);
  if (!token.token) {
    throw new Error("GitHub returned no registration token");
  }
  // Masked before anything else is printed; only its ciphertext leaves this function.
  deps.log(`::add-mask::${token.token}`);
  const ciphertext = await deps.age.encrypt(key!, token.token);
  deps.log(`Encrypted a registration token that expires at ${token.expiresAt}`);
  const registration = { login, keyId, expiresAt: token.expiresAt, ciphertext };
  return { kind: "answered", body: registrationBody(repo, registration) };
}

/**
 * Writes the answer as `github-actions[bot]`'s marked comment (the REST comment
 * list, so the job token needs only the Issues permission); a refusal also closes
 * the Issue as not planned.
 */
async function writeAnswer(
  deps: RunnerRequestDeps,
  issue: IssueRef,
  answer: Answer,
): Promise<void> {
  const refused = answer.kind === "refused";
  const key = refused ? refusedKey : registrationKey;
  const body = refused ? refusalBody(answer.refusal) : answer.body;
  const comment = await upsertMarkedComment(deps.job, issue, key, body, "pull-request");
  deps.log(`Answered ${formatIssue(issue)}: ${comment.url}`);
  if (refused) {
    await closeIssueNotPlanned(deps.job, issue);
    deps.log(`Closed ${formatIssue(issue)} as not planned`);
  }
}

/**
 * Answers a runner request: a body without the request marker is not one; a request
 * that is no longer open is not answered again. Otherwise the request's checks
 * (`checkRequest`), the author's write or admin permission, and the SSH key it names
 * (`checkKey`) decide a refusal; else `age --version` runs before any write, the
 * optional deploy key is added, and a registration token is created, masked,
 * encrypted to that key and answered. A refusal closes the Issue as not planned. Any
 * failure is answered as "the request workflow failed (<run URL>)" with that close
 * and then thrown.
 */
export async function answerRequest(
  input: RunnerRequestInput,
  deps: RunnerRequestDeps,
): Promise<RequestOutcome> {
  const { repo, issue } = input;
  const ref: IssueRef = { ...repo, number: issue.number };
  const name = formatIssue(ref);
  if (!issue.body.includes(requestMarker)) {
    deps.log(`${name} is not a runner request; nothing to answer`);
    return "not-a-request";
  }
  let answer: Answer;
  try {
    const state = await readIssueState(deps.job, ref);
    if (state !== "open") {
      deps.log(`${name} is ${state}; nothing to answer`);
      return "not-open";
    }
    const check = checkRequest(issue, repo);
    answer = check.kind === "refused" ? check : await prepare(input, deps, check);
  } catch (error) {
    deps.log(`The request failed: ${describeFailure(error)}`);
    await writeAnswer(deps, ref, { kind: "refused", refusal: failedRefusal(input.url) });
    throw error;
  }
  if (answer.kind === "refused") {
    deps.log(`Refused: ${answer.refusal.reason}`);
  }
  await writeAnswer(deps, ref, answer);
  return answer.kind;
}
