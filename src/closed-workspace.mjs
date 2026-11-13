import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { CandidateWorkspace } from './workspace.mjs';
import { digest } from './identity.mjs';

// Called while the Issue fence is still held and the writer is gone.
export async function cleanClosedWorkspace({ progress, approval, reader }) {
  const issue = approval.record.issue;
  const { store, workspaceRoot, marker } = progress;
  const receipts = await store.load();
  if (receipts.close?.outcome !== 'closed' || receipts.merge?.outcome !== 'merged') {
    return;
  }
  const live = await reader.issue(issue);
  if (live.state !== 'closed' || live.node_id !== issue.id ||
      live.number !== issue.number ||
      !live.labels?.some(label => label.name === 'delivered'))
    return;
  await store.get(digest(marker));
  const shape = receipts['publish-shape']?.requirementsBody;
  if (typeof shape !== 'string') return;
  try { await lstat(join(workspaceRoot, 'work')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const candidate = await store.get(receipts.close.artifacts.candidateHash);
  if (!await new CandidateWorkspace(workspaceRoot, issue).cleanDeliveredWork(candidate,
    shape)) console.error('Nibfin retained local files outside the delivered candidate');
}
