import { constants } from 'node:fs';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, requireThat } from './identity.mjs';
import { privateHostDirectory } from './host-fence.mjs';
import { readObservationFile } from './local-work-files.mjs';
import { prepareDiagnosisInvocation } from './diagnosis-invocation.mjs';
import { projectDiagnosisReport } from './diagnosis-report.mjs';

async function create(path, value) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
}
async function sync(root) {
  const file = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await file.sync(); } finally { await file.close(); }
}

// This state owns only diagnostic capacity. It never opens delivery journals,
// fences, RoleSessions, workspace state, publishers or workflow dispatchers.
export async function coordinateDiagnosis(input, {
  prepare = prepareDiagnosisInvocation,
} = {}) {
  const { host, subject, issue, attempt, evidence, evidenceId } = input;
  const response = (status, code) => ({ schemaVersion: 1, status, code,
    executionAuthority: false });
  let invoke;
  try {
    requireThat(process.getuid?.() === host.uid, 'CONTROLLER_ACCESS_REQUIRED');
    await privateHostDirectory(host.stateRoot);
    await host.confirm();
  } catch { return response('no-capacity', 'AUTHORIZED_DIAGNOSIS_CAPACITY_UNAVAILABLE'); }
  requireThat(Buffer.byteLength(JSON.stringify(evidence)) <= 32 * 1024,
    'DIAGNOSIS_INPUT_LIMIT');
  const key = digest({ subjectId: subject.id, issue, attempt, evidenceId });
  const root = join(host.stateRoot, 'diagnoses');
  try {
    await mkdir(root, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    await privateHostDirectory(root);
  } catch { return response('no-capacity', 'DIAGNOSIS_STATE_UNAVAILABLE'); }
  const claim = join(root, `${key}.inflight`);
  const done = join(root, `${key}.json`);
  const capacity = join(root, 'active.lock');
  const read = async path => JSON.parse(
    (await readObservationFile(path, host.uid, 64 * 1024)).bytes);
  const prior = async () => {
    try {
      const result = await read(done);
      requireThat(result.key === key, 'DIAGNOSIS_STATE_UNAVAILABLE');
      return result.response;
    } catch (error) {
      if (error.code !== 'ENOENT')
        return response('unresolved-effect', 'DIAGNOSIS_STATE_UNAVAILABLE');
    }
    return null;
  };
  const completed = await prior();
  if (completed) return completed;
  const invocationId = randomUUID();
  const record = { schemaVersion: 1, key, invocationId, subjectId: subject.id,
    issue, attempt, evidenceId, createdAt: new Date().toISOString() };
  try { await create(claim, record); await sync(root); }
  catch { return await prior() ?? response('unresolved-effect',
    'DIAGNOSIS_ALREADY_IN_FLIGHT'); }
  try { await create(capacity, record); await sync(root); }
  catch (error) {
    // No invocation was entered. This request's claim can be safely retired.
    await unlink(claim); await sync(root);
    return response('no-capacity', 'DIAGNOSIS_CAPACITY_BUSY');
  }
  const retire = async () => {
    requireThat((await read(capacity)).invocationId === invocationId &&
      (await read(claim)).invocationId === invocationId, 'DIAGNOSIS_CLAIM_CHANGED');
    await unlink(capacity); await unlink(claim); await sync(root);
  };
  try {
    invoke = await prepare(host, issue);
    await host.confirm();
  } catch {
    // Preparation owns no model process or persistent execution resource.
    try { await retire(); }
    catch { return response('unresolved-effect', 'DIAGNOSIS_STATE_UNAVAILABLE'); }
    return response('no-capacity', 'AUTHORIZED_DIAGNOSIS_CAPACITY_UNAVAILABLE');
  }
  let outcome;
  try {
    outcome = await invoke({ invocationId, evidence, directory: root });
  } catch {
    // Unknown process/cleanup state is durable. No timeout, PID lookup, missing
    // Runner or elapsed lease can justify removing either record.
    return response('unresolved-effect', 'DIAGNOSIS_TERMINATION_UNKNOWN');
  }
  if (outcome?.terminated !== true)
    return response('unresolved-effect', 'DIAGNOSIS_TERMINATION_UNKNOWN');
  const result = outcome.report ? { schemaVersion: 1, status: 'reported',
    report: projectDiagnosisReport({ ...outcome.report, invocationId, evidenceId,
      sourceReports: evidence.map(item => item.reference),
      issue, attempt, subjectId: subject.id, observedAt: new Date().toISOString(),
      confirmed: [...new Set(evidence.flatMap(item => item.confirmed ?? []))],
      sourceTimes: evidence.map(item => item.observedAt ?? null),
      executionAuthority: false }, record), executionAuthority: false }
    : response('insufficient-evidence', 'DIAGNOSIS_REPORT_UNAVAILABLE');
  try {
    await create(done, { key, record, response: result }); await sync(root);
    await retire();
  } catch { return response('unresolved-effect', 'DIAGNOSIS_STATE_UNAVAILABLE'); }
  return result;
}
