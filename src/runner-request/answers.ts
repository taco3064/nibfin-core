// The answers of a runner request (#776): marked comments of `github-actions[bot]`
// that gh-nibfin's `runner add` reads (`internal/runnerreq`). Their bodies are kept
// byte for byte; `upsertMarkedComment` writes the marker line before them.
import type { Repo } from "../github/repo.ts";
import type { Refusal } from "./check.ts";

/** The comment key of a registration token answer. */
export const registrationKey = "runner-registration";

/** The comment key of a refusal, also of a failed request. */
export const refusedKey = "runner-request-refused";

/** The body of a refusal: its reason and what the requester does next. */
export function refusalBody(refusal: Refusal): string {
  return `reason: ${refusal.reason}\n\n${refusal.next}\n`;
}

/** The refusal of a request whose workflow failed, naming the run. */
export function failedRefusal(url: string | undefined): Refusal {
  return {
    reason: `the request workflow failed (${url ?? "unknown"})`,
    next: "Read the run's log; run gh nibfin runner add again when the cause is fixed.",
  };
}

/** What a registration answer carries; the token itself only encrypted. */
export interface Registration {
  login: string;
  keyId: string;
  expiresAt: string;
  /** `age -a` output for the requester's SSH key. */
  ciphertext: string;
}

/** The body of a registration answer. */
export function registrationBody(repo: Repo, registration: Registration): string {
  const { login, keyId, expiresAt, ciphertext } = registration;
  return [
    `requester: ${login}`,
    `ssh-key-id: ${keyId}`,
    `expires-at: ${expiresAt}`,
    "",
    `A runner registration token for ${repo.owner}/${repo.repo}, encrypted to the ` +
      `SSH key ${keyId} of @${login}. gh nibfin runner add decrypts it and registers ` +
      "the runner.",
    "",
    "```text",
    ciphertext.replace(/\n+$/, ""),
    "```",
    "",
  ].join("\n");
}
