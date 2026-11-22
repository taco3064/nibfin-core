import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readNotionProposal } from './notion-proposal.mjs';
import { readGlobalInstructions } from './host-adoption.mjs';
import { issueStatePath, privateHostDirectory } from './host-fence.mjs';
import { retainHostOutcome } from './blocker-native-report.mjs';

const proposalCodes = new Set([
  'INVALID_NOTION_PROPOSAL_ADOPTION',
  'NOTION_PROPOSAL_CREDENTIAL_UNAVAILABLE',
  'NOTION_PROPOSAL_CREDENTIAL_REJECTED',
  'NOTION_PROPOSAL_ACCESS_DENIED',
  'NOTION_PROPOSAL_UNAVAILABLE',
  'NOTION_PROPOSAL_INCOMPLETE',
]);

// Called only after native Job, caller and Issue approval verification. These
// reads precede any owned work and cannot start an Agent or settle work.
export async function readHostStageInputs(context, binding, stage, {
  readProposal = readNotionProposal, readInstructions = readGlobalInstructions,
} = {}) {
  const { host, adopted, targetHost } = context;
  const source = adopted.notionProposal ?? targetHost?.notionProposal ??
    host.notionProposal;
  let phase = 'proposal';
  try {
    const proposal = source === undefined ? undefined : await readProposal(source);
    phase = 'instructions';
    const globalInstructions = await readInstructions(host);
    return { proposal, globalInstructions };
  } catch (error) {
    const code = phase === 'instructions' ? 'GLOBAL_INSTRUCTIONS_UNAVAILABLE'
      : proposalCodes.has(error?.code) ? error.code : 'NOTION_PROPOSAL_UNAVAILABLE';
    const outcome = { schemaVersion: 1, stage, status: 'denied', code };
    try {
      const root = issueStatePath(host.stateRoot, binding.approval.record.issue);
      // Verify every existing parent before writing; never follow a state symlink.
      await privateHostDirectory(host.stateRoot);
      for (const path of [root, join(root, 'receipts')]) {
        await mkdir(path, { mode: 0o700 }).catch(failure => {
          if (failure.code !== 'EEXIST') throw failure;
        });
        await privateHostDirectory(path);
      }
      return { outcome: await retainHostOutcome(root, binding, stage, outcome) };
    } catch {
      return { outcome: { ...outcome, reportStatus: 'unavailable' } };
    }
  }
}
