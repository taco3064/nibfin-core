import { isId, isSha } from './identity.mjs';
import { issuePath, repoPath } from './github-read.mjs';

const prefix = 'missing-upstream ';
const locator =
  /^([\w.-]+\/[\w.-]+)#([1-9]\d*)(?: via #([1-9]\d*))?$/;
const checkUpstream = 'Identify the Issue that owns the missing upstream change.';

async function comparison(reader, repository, merge, ref) {
  return (await reader.get(`${repository}/compare/${merge}...${ref}`))?.status;
}

function includesMerge(status) { return status === 'ahead' || status === 'identical'; }

export async function blockedGuidance(reader, issue, references, workspaceBase) {
  const markers = references.filter(value => value.startsWith(prefix));
  if (!markers.length) return;
  const target = `${issue.repository}#${issue.number}`;
  const fallback = `${target} is missing an upstream change. ${checkUpstream}`;
  if (markers.length !== 1 || markers[0].length > 180) return fallback;
  const match = locator.exec(markers[0].slice(prefix.length));
  if (!match || match[0] !== markers[0].slice(prefix.length)) return fallback;
  const [, repository, number, pull] = match;
  const upstream = { repository, number: Number(number) };
  const prerequisite = `${repository}#${number}`;
  try {
    const path = issuePath(upstream);
    if (path.toLowerCase() === issuePath(issue).toLowerCase() ||
      (pull && !isId(Number(pull)))) return fallback;
    const remote = await reader.issue(upstream);
    if (!remote?.node_id || remote.number !== upstream.number || remote.pull_request ||
      remote.url !== `https://api.github.com${path}` ||
      !['open', 'closed'].includes(remote.state)) return fallback;

    const repo = repoPath(repository);
    if (pull) {
      const pr = await reader.get(`${repo}/pulls/${pull}`);
      const mainMerge = pr?.number === Number(pull) && pr.merged === true &&
        pr.base?.ref === 'main' && pr.base.repo?.full_name === repository &&
        isSha(pr.merge_commit_sha) &&
        pr.body?.split(/\r?\n/).includes(`Implements #${number}.`) &&
        includesMerge(await comparison(reader, repo, pr.merge_commit_sha, 'main'));
      if (mainMerge) {
        const merged = `${prerequisite} was merged into main via ${repository}#${pull}.`;
        if (issue.repository === repository) {
          const base = await workspaceBase();
          if (isSha(base)) {
            const status = await comparison(reader, repo, pr.merge_commit_sha, base);
            if (status === 'behind' || status === 'diverged') {
              return `${merged} The workspace base for ${target} lacks that merge. ` +
                'Refresh the workspace from current main and rerun Deliver.';
            }
          }
        }
        return `${merged} Check why the required change is unavailable to ${target}.`;
      }
    }
    if (remote.state === 'closed') {
      return `${prerequisite} is closed and its merge into main is unverified. ` +
        `Check whether it delivers the change required by ${target}.`;
    }
    const edges = await reader.blockedBy(issue);
    if (edges.some(edge => edge?.node_id === remote.node_id &&
      edge.url === remote.url && edge.number === remote.number)) {
      return `${target} already has ${prerequisite} as Blocked by. ` +
        'Wait for the upstream Issue to deliver.';
    }
    return `${target} requires open ${prerequisite}. ` +
      `In GitHub, set ${target} to Blocked by ${prerequisite}.`;
  } catch {
    return `Could not verify the upstream Issue or dependency for ${target}. ` +
      'Check GitHub before changing Blocked by.';
  }
}
