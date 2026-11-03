import { constants } from 'node:fs';
import { mkdir, lstat, open, realpath, unlink, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { digest, isDigest, requireThat } from './identity.mjs';
import { evidenceBinding, executionIdentity, stages } from './stages.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

// Private per-execution directories fence an in-flight invocation. Fresh Shaper
// review reads current sources; historical conversations are never required.
export class RoleSessions {
  #root;
  constructor(root) { this.#root = resolve(root); }
  async run(stage, context, execute) {
    requireThat(['shape', 'validate-shape', 'deliver', 'accept', 'review-pr'].includes(stage) && typeof execute === 'function', 'INVALID_SESSION_ROLE');
    const role = stages[stage].role, execution = executionIdentity(context.execution, role, context.approval.record.roles[role]);
    const binding = { ...evidenceBinding(context), memberId: execution.actorId, role, executionId: execution.id, sessionId: execution.sessionId };
    const directory = join(this.#root, `session-${digest(binding)}`), home = join(directory, 'home');
    const stat = await lstat(this.#root);
    requireThat(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0 &&
      await realpath(this.#root) === this.#root, 'UNTRUSTED_SESSION_ROOT');
    await mkdir(directory, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
    for (const path of [directory, home]) {
      const current = await lstat(path);
      requireThat(current.isDirectory() && current.uid === process.getuid() && (current.mode & 0o077) === 0 &&
        await realpath(path) === path, 'UNTRUSTED_ROLE_SESSION');
    }
    const lockPath = join(directory, 'active.lock');
    const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await lock.writeFile(JSON.stringify({ executionId: execution.id, bindingHash: digest(binding) })); await lock.sync(); await lock.close();
    const sync = async () => {
      for (const path of [directory, this.#root]) {
        const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await file.sync(); } finally { await file.close(); }
      }
    };
    await sync();
    // Any failure below deliberately retains the lease. A dead process or a
    // missing result does not establish that all isolated writers terminated.
    const result = await execute({ directory: home, threadId: null });
    requireThat(result?.executionId === execution.id && isDigest(result.terminationHash) && uuid(result.threadId), 'ROLE_SESSION_RESULT_MISMATCH');
    // Retain no transcript or copied subscription authentication after known
    // termination. The small execution directory fences replay; unknown runs
    // retain their lock and are never reclaimed merely because a job ended.
    await rm(home, { recursive: true });
    await unlink(lockPath); await sync(); return result;
  }
}
