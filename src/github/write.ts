import { GitHubError, isUnknownOutcome } from "./errors.ts";
import { retrySettingsOf } from "./read-cache.ts";
import { giveUpLine, maxRetries, requestName, retryCause, waitToRetry } from "./retry.ts";

export interface WriteRecovery<T> {
  /**
   * Re-reads GitHub to see whether the write took effect; a value means it did. Runs
   * after an unknown outcome and before every re-send.
   */
  confirm: () => Promise<T | undefined>;
  /** Handles a 4xx answer that may still mean success; `undefined` = rejected. */
  recover?: (error: unknown) => Promise<T | undefined>;
}

/**
 * Runs one write attempt. An unknown outcome (no response, or 5xx) is re-read before
 * anything else: a confirmed result is reused, otherwise `GITHUB_WRITE_UNCONFIRMED`.
 * Any other failure is `GITHUB_WRITE_REJECTED` unless `recover` shows the intended
 * state.
 */
export async function writeOnce<T>(
  operation: string,
  run: () => Promise<T>,
  recovery: WriteRecovery<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isUnknownOutcome(error)) {
      const confirmed = await recovery.confirm().catch(() => undefined);
      if (confirmed !== undefined) {
        return confirmed;
      }
      throw new GitHubError("GITHUB_WRITE_UNCONFIRMED", operation, error);
    }
    const recovered = await recovery.recover?.(error);
    if (recovered !== undefined) {
      return recovered;
    }
    throw new GitHubError("GITHUB_WRITE_REJECTED", operation, error);
  }
}

/**
 * Runs a write and retries it on any error up to `maxRetries` times (Proposal
 * R4.37–R4.38). A 4xx that `recover` shows as the intended state is success and is
 * not retried. Before each re-send the client's retry wait passes, then `confirm`
 * re-reads GitHub: a write that already took effect is not sent again. A failing
 * pre-read ends the write without a re-send. After the last retry an unknown outcome
 * (no response, or 5xx) is re-read once more and is `GITHUB_WRITE_UNCONFIRMED`; any
 * other failure is `GITHUB_WRITE_REJECTED`. The cause is the write's last error.
 */
export async function write<T>(
  client: object,
  operation: string,
  run: () => Promise<T>,
  recovery: WriteRecovery<T>,
): Promise<T> {
  for (let k = 1; ; k += 1) {
    let error: unknown;
    try {
      return await run();
    } catch (caught) {
      error = caught;
    }
    const unknown = isUnknownOutcome(error);
    if (!unknown) {
      const recovered = await recovery.recover?.(error);
      if (recovered !== undefined) {
        return recovered;
      }
    }
    const code = unknown ? "GITHUB_WRITE_UNCONFIRMED" : "GITHUB_WRITE_REJECTED";
    const what = requestName(error, operation);
    if (k > maxRetries) {
      const confirmed = unknown
        ? await recovery.confirm().catch(() => undefined)
        : undefined;
      if (confirmed !== undefined) {
        return confirmed;
      }
      retrySettingsOf(client).log(giveUpLine(what, retryCause(error)));
      throw new GitHubError(code, operation, error);
    }
    await waitToRetry(client, what, error, k);
    let confirmed: T | undefined;
    try {
      confirmed = await recovery.confirm();
    } catch {
      throw new GitHubError(code, operation, error);
    }
    if (confirmed !== undefined) {
      return confirmed;
    }
  }
}
