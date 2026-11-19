import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, requireThat } from './identity.mjs';
import { stages } from './stages.mjs';
import { boundedHostFile } from './host-adoption.mjs';
import { privateHostDirectory } from './host-fence.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';

export function controllerRequest({ approval, runner, stage, execution, binding }) {
  const { id, number, repository, repositoryId } = approval.record.issue;
  return { issue: { id, number, repository, repositoryId }, binding, stage, execution,
    native: { repositoryId: (runner.target ?? runner).repositoryId,
      runId: runner.runId, attempt: runner.attempt, jobId: runner.jobId,
      memberId: runner.memberId, sourceCommit: runner.sourceCommit } };
}

// Only admitted Controller paths and identities reach this storage boundary.
// The mutable reference is invalidated before work; objects use EvidenceStore.
export class ControllerResult {
  constructor(root, request, store) {
    this.directory = join(root, 'controller-results');
    this.request = structuredClone(request);
    this.store = store;
    this.name = `${digest(request)}.json`;
  }
  async prepare() {
    await mkdir(this.directory, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    await privateHostDirectory(this.directory);
    await syncRecoveryDirectory(join(this.directory, '..'));
  }
  async write(pointer) {
    await this.prepare();
    const temp = join(this.directory, `${randomUUID()}.tmp`);
    try {
      const file = await open(temp, constants.O_WRONLY | constants.O_CREAT |
        constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(JSON.stringify(pointer));
        await file.sync();
      } finally { await file.close(); }
      await rename(temp, join(this.directory, this.name));
      await syncRecoveryDirectory(this.directory);
    } finally {
      await unlink(temp).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
  async begin() {
    await this.prepare();
    const lock = await open(join(this.directory, `${this.name}.lock`),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    try { await lock.sync(); } finally { await lock.close(); }
    await syncRecoveryDirectory(this.directory);
    await this.write({ state: 'unsettled' });
  }
  async record(result, execution, iteration = 0,
    executionStage = result.stage ?? this.request.stage) {
    const stage = result.stage ?? executionStage;
    requireThat(Object.hasOwn(stages, stage), 'CONTROLLER_RESULT_STAGE_UNPROVEN');
    const bounded = { schemaVersion: 1, stage,
      status: result.status, ...(result.code ? { code: result.code } : {}),
      ...(result.receiptHash ? { receiptHash: result.receiptHash } : {}) };
    requireThat(Buffer.byteLength(JSON.stringify(bounded)) <= 4096,
      'CONTROLLER_RESULT_SIZE_LIMIT');
    const receipts = await this.store.load();
    return this.store.put({ kind: 'controller-result', schemaVersion: 1,
      request: this.request, result: bounded, execution, iteration, executionStage,
      receipts: Object.fromEntries(Object.entries(receipts)
        .map(([stage, receipt]) => [stage, digest(receipt)])) });
  }
  async settle(hash) {
    await this.write({ state: 'settled', resultHash: hash });
    await unlink(join(this.directory, `${this.name}.lock`));
    await syncRecoveryDirectory(this.directory);
  }
  async read() {
    await privateHostDirectory(this.directory);
    const active = await lstat(join(this.directory, `${this.name}.lock`))
      .catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
    requireThat(!active, 'CONTROLLER_RESULT_UNSETTLED');
    const pointer = JSON.parse(await boundedHostFile(
      join(this.directory, this.name), 4096, true));
    requireThat(pointer.state === 'settled', 'CONTROLLER_RESULT_UNSETTLED');
    const record = await this.store.get(pointer.resultHash);
    requireThat(record.kind === 'controller-result' && record.schemaVersion === 1 &&
      digest(record.request) === digest(this.request), 'CONTROLLER_RESULT_UNBOUND');
    return { record, hash: pointer.resultHash };
  }
}

// A durable result is not settlement proof until the owning fence is released.
// Every interruption before the last write leaves the reference unresolved.
export async function releaseControllerResult({
  evidence, result, execution, iteration = 0, executionStage, release,
}) {
  const hash = await evidence.record(result, execution, iteration, executionStage);
  await release();
  await evidence.settle(hash);
}
