// The checks of a runner request (#776, R5.59–R5.62), pure: what the request Issue
// says, as the event gave it, and the SSH key it names. The refusal texts are the
// ones gh-nibfin's `runner add` shows (`internal/runnerreq`).
import type { Repo } from "../github/repo.ts";

/** The line every runner request body carries; the workflow's job filters on it. */
export const requestMarker = "<!-- nibfin:runner-request -->";

/** The title gh-nibfin's `runner add` gives a request. */
export const requestTitle = "Nibfin runner request";

/** The request Issue as the `issues` `opened` event gave it. */
export interface RequestIssue {
  number: number;
  title: string;
  body: string;
  /** The author's login and account type (`User`, `Bot`, `Organization`). */
  login: string;
  userType: string;
}

/** Why a request is refused, and what the requester does next. */
export interface Refusal {
  reason: string;
  next: string;
}

/** A request that passed the body checks. */
export interface CheckedRequest {
  /** The id of the requester's SSH key the token is encrypted to. */
  keyId: string;
  /** The optional deploy key, `ssh-ed25519 <base64>`. */
  deployKey: string | undefined;
}

export type RequestCheck =
  { kind: "refused"; refusal: Refusal } | ({ kind: "ok" } & CheckedRequest);

const openAgain = "Open the request with gh nibfin runner add.";
const keyIdLine = /^ssh-key-id: ([1-9][0-9]{0,18})$/;
const deployKeyLine = /^deploy-key: ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$/;

/** The wire format of an ssh-ed25519 public key: length 11, the name, length 32. */
const ed25519Prefix = Buffer.from("0000000b7373682d6564323535313900000020", "hex");
const ed25519Length = ed25519Prefix.length + 32;

const refused = (reason: string, next = openAgain): RequestCheck => ({
  kind: "refused",
  refusal: { reason, next },
});

/** Whether `blob` is the base64 of an ssh-ed25519 public key, down to its bytes. */
function isEd25519(blob: string): boolean {
  if (blob.length % 4 !== 0) {
    return false;
  }
  const bytes = Buffer.from(blob, "base64");
  return (
    bytes.length === ed25519Length &&
    bytes.subarray(0, ed25519Prefix.length).equals(ed25519Prefix)
  );
}

/**
 * Checks a request as the event gave it, in this order: the title, an author of type
 * `User`, exactly one `ssh-key-id: <id>` line (`<id>` is `[1-9][0-9]{0,18}`), and at
 * most one `deploy-key: ssh-ed25519 <base64>` line whose key decodes to the
 * ssh-ed25519 wire format. Carriage returns are removed first.
 */
export function checkRequest(issue: RequestIssue, repo: Repo): RequestCheck {
  if (issue.title !== requestTitle) {
    return refused(`the title is not "${requestTitle}"`);
  }
  if (issue.userType !== "User") {
    return refused(
      `the author ${issue.login} is a ${issue.userType} account, not a user`,
      `A user with write access to ${repo.owner}/${repo.repo} opens the request ` +
        "with gh nibfin runner add.",
    );
  }
  const lines = issue.body.replaceAll("\r", "").split("\n");
  const keyLines = lines.filter((line) => line.startsWith("ssh-key-id:"));
  if (keyLines.length !== 1) {
    return refused(`the body has ${keyLines.length} ssh-key-id lines, want exactly one`);
  }
  const keyId = keyIdLine.exec(keyLines[0])?.[1];
  if (keyId === undefined) {
    return refused('the ssh-key-id line is not "ssh-key-id: <id>"');
  }
  const deployLines = lines.filter((line) => line.startsWith("deploy-key:"));
  if (deployLines.length > 1) {
    return refused(
      `the body has ${deployLines.length} deploy-key lines, want at most one`,
    );
  }
  if (deployLines.length === 0) {
    return { kind: "ok", keyId, deployKey: undefined };
  }
  const blob = deployKeyLine.exec(deployLines[0])?.[1];
  if (blob === undefined || !isEd25519(blob)) {
    return refused("the deploy-key line is not an ssh-ed25519 public key");
  }
  return { kind: "ok", keyId, deployKey: `ssh-ed25519 ${blob}` };
}

/** The refusal for an author without write or admin permission. */
export function permissionRefusal(
  login: string,
  permission: string,
  repo: Repo,
): Refusal {
  const name = `${repo.owner}/${repo.repo}`;
  return {
    reason: `${login} has ${permission} permission on ${name}, not write or admin`,
    next:
      `Ask the owner of ${name} to make you a collaborator with write access, then ` +
      "run gh nibfin runner add again.",
  };
}

/** The type of a public key `<type> <base64>`: the text before the first space. */
export function keyType(key: string): string {
  return key.split(" ")[0];
}

/**
 * Checks the SSH key the request names, `undefined` when the account has no key with
 * that id: only ssh-ed25519 and ssh-rsa keys are taken. Returns the refusal, if any.
 */
export function checkKey(
  login: string,
  keyId: string,
  key: string | undefined,
): Refusal | undefined {
  if (key === undefined || key === "") {
    return {
      reason: `${login} has no SSH key with id ${keyId} on GitHub`,
      next:
        "Add the SSH key to your GitHub account, then run gh nibfin runner add " +
        "again.",
    };
  }
  if (!key.startsWith("ssh-ed25519 ") && !key.startsWith("ssh-rsa ")) {
    return {
      reason:
        `the SSH key ${keyId} of ${login} is ${keyType(key)}, ` +
        "not ssh-ed25519 or ssh-rsa",
      next:
        "Use an ssh-ed25519 or ssh-rsa key of your GitHub account with " +
        "gh nibfin runner add.",
    };
  }
  return undefined;
}
