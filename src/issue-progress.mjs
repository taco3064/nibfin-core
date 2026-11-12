import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { EvidenceStore } from './evidence-store.mjs';
import { privateHostDirectory } from './host-fence.mjs';
import { digest, isDigest, isId, requireThat } from './identity.mjs';
import { stageSuccess } from './stage-runtime.mjs';
import { evidenceBinding, stages } from './stages.mjs';

async function readLegacyObject(directory, name) {
  let file;
  try {
    file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT' && name === 'shape.json') return null;
    throw error;
  }
  try {
    const stat = await file.stat();
    requireThat(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 &&
      (stat.mode & 0o077) === 0 && stat.size <= 8 * 1024 * 1024,
    'UNTRUSTED_EVIDENCE_FILE');
    return JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
}

function openProgress(root, binding, workspace) {
  const workspaceRoot = join(root, workspace);
  const store = new EvidenceStore(join(root, 'receipts'), binding);
  const marker = { kind: 'host-workspace', directory: workspaceRoot, binding };
  return { workspaceRoot, binding, store, marker };
}

async function readLegacyProgress(root, directory, approval) {
  await privateHostDirectory(directory);
  const pointer = await readLegacyObject(directory, 'shape.json');
  if (!pointer) return null;
  requireThat(isDigest(pointer.receiptHash), 'INVALID_EVIDENCE_ID');
  const receipt = await readLegacyObject(directory, pointer.receiptHash);
  const { binding } = receipt;
  requireThat(digest(receipt) === pointer.receiptHash &&
    directory.endsWith(`/evidence-${digest(binding)}`),
  'EVIDENCE_OBJECT_CORRUPT');
  if (binding.issueId !== approval.record.issue.id ||
    binding.scopeHash !== approval.scopeBinding) return null;
  requireThat(isDigest(binding.sourceHash), 'INVALID_EVIDENCE_BINDING');
  const progress = openProgress(root, binding, `workspace-${binding.sourceHash}`);
  const receipts = await progress.store.load();
  const values = Object.values(receipts);
  if (!values.every(entry => entry.execution?.actorId ===
    approval.record.roles[stages[entry.stage].role])) return null;
  requireThat(values.every(entry => isId(entry.execution.runId)),
    'INVALID_LEGACY_EXECUTION');
  await privateHostDirectory(progress.workspaceRoot);
  const marker = await progress.store.get(digest(progress.marker));
  requireThat(digest(marker) === digest(progress.marker),
    'WORKSPACE_ADOPTION_UNRESOLVED');
  return {
    progress,
    published: receipts['commit-pr']?.outcome === 'published',
    completed: values.filter(entry => entry.outcome === stageSuccess[entry.stage]).length,
    latestRun: Math.max(...values.map(entry => entry.execution.runId)),
  };
}

// The caller holds the existing Issue fence. New workspace selection is based on
// the Issue directory. Prior installations retain their original evidence bytes.
export async function issueProgress(root, approval) {
  const binding = evidenceBinding({ approval });
  if (approval.scopeBinding === undefined)
    return openProgress(root, binding, `workspace-${binding.sourceHash}`);
  const current = openProgress(root, binding, 'workspace');
  try {
    const stat = await lstat(current.workspaceRoot);
    requireThat(stat.isDirectory() && await realpath(current.workspaceRoot) ===
      current.workspaceRoot, 'UNTRUSTED_WORKSPACE_DIRECTORY');
    return current;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const receiptsRoot = join(root, 'receipts');
  const entries = await readdir(receiptsRoot);
  const legacy = [];
  for (const name of entries.filter(entry => /^evidence-[a-f0-9]{64}$/.test(entry))) {
    const item = await readLegacyProgress(root, join(receiptsRoot, name), approval);
    if (item) legacy.push(item);
  }
  const published = legacy.filter(item => item.published);
  requireThat(published.length <= 1, 'MULTIPLE_LEGACY_PULL_REQUESTS');
  if (published.length === 1) return published[0].progress;
  legacy.sort((first, second) => second.latestRun - first.latestRun ||
    second.completed - first.completed);
  return legacy[0]?.progress ?? current;
}
