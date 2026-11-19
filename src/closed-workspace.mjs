import { lstat, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CandidateWorkspace } from './workspace.mjs';
import { digest } from './identity.mjs';
import { privateHostDirectory } from './host-fence.mjs';

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
  const published = receipts['publish-shape'];
  const shape = published?.requirementsBody ?? (published?.artifacts?.shapeHash
    ? await store.get(published.artifacts.shapeHash) : undefined);
  if (typeof shape !== 'string') return;
  let workExists = true;
  try { await lstat(join(workspaceRoot, 'work')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; workExists = false; }
  if (workExists) {
    const candidate = await store.get(receipts.close.artifacts.candidateHash);
    if (!await new CandidateWorkspace(workspaceRoot, issue).cleanDeliveredWork(candidate,
      shape)) {
      console.error('Nibfin retained local files outside the delivered candidate');
      return;
    }
  }
  // GitHub has the merged source. Keep the small receipts/journal outside these
  // directories so closure read-back and interrupted cleanup remain resumable.
  for (const path of [workspaceRoot, join(dirname(workspaceRoot), 'agent')]) {
    try { await privateHostDirectory(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await rm(path, { recursive: true });
  }
}
