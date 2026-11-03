import { GitHubReader, repoPath } from './github-read.mjs';
import { readProtectedApproval, readMemberPermission, readPinnedFile } from './github-approval.mjs';
import { readDependencies, isDeliveredIssue } from './dependencies.mjs';
import { selectAssignee } from './selection.mjs';
import { bindRawScope } from './approval-record.mjs';
import { digest, isId, isSha, requireThat } from './identity.mjs';

// Runs on a trusted hosted preflight, before selecting a self-hosted Runner.
// Events only locate an adopted Issue identity. No event field grants authority.
export async function observeWake(reader, { approvalPin, workflow, actorId }, clock = Date.now) {
  requireThat(isId(actorId) && isId(workflow?.id) && isSha(workflow.commit) && isSha(workflow.blob) &&
    /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow.path), 'INVALID_WAKE_PIN');
  const approval = await readProtectedApproval(reader, approvalPin, clock());
  const record = approval.record, issue = record.issue, root = repoPath(issue.repository);
  requireThat(record.operations.includes('wake'), 'WAKE_NOT_APPROVED');
  const dependencies = await readDependencies(reader, issue, record.prerequisites);
  const current = dependencies.issue;
  requireThat(current.labels.some(label => label.name === 'scope') && !current.labels.some(label => label.name === 'delivered'), 'INACTIVE_WAKE_TARGET');
  // Shaped work is not reconstructed from mutable text here. Its full evidence
  // is checked at execution admission; a wake never grants stage permission.
  if (!current.labels.some(label => label.name === 'shaped')) bindRawScope(record, current);
  const route = await selectAssignee(current, async user => {
    if (user.id !== record.roles.writer) return false;
    await readMemberPermission(reader, issue.repository, { ...user, type: 'User' }); return true;
  });
  requireThat(route && dependencies.ready, 'WAKE_TARGET_NOT_READY');
  const entryStage = current.labels.some(label => label.name === 'shaped') ? 'deliver' : 'shape';
  requireThat(record.operations.includes(entryStage) &&
    record.roles[entryStage === 'shape' ? 'author' : 'writer'] === route.userId, 'WAKE_ENTRY_NOT_APPROVED');
  const actor = await reader.get('/user');
  requireThat(actor.type === 'User' && actor.id === actorId && actor.id === record.roles.publisher, 'WAKE_ACTOR_CHANGED');
  await readMemberPermission(reader, issue.repository, actor);
  const repository = await reader.repository(issue.repository);
  const branch = await reader.get(`${root}/branches/${encodeURIComponent(repository.default_branch)}`);
  requireThat(branch.protected === true && branch.commit?.sha === workflow.commit, 'WAKE_WORKFLOW_SOURCE_CHANGED');
  const actual = await reader.get(`${root}/actions/workflows/${workflow.id}`);
  requireThat(actual.id === workflow.id && actual.path === workflow.path && actual.state === 'active', 'WAKE_WORKFLOW_UNAVAILABLE');
  await readPinnedFile(reader, issue.repository, workflow.path, workflow.commit, workflow.blob);
  return { issue, approvalHash: approval.approvalHash, workflow: { ...workflow, ref: repository.default_branch },
    actorId, route, entryStage, stateHash: digest({ body: current.body, labels: current.labels, assignees: current.assignees,
      prerequisites: dependencies.prerequisites }) };
}

// The native 2026-03-10 dispatch endpoint returns the actual run ID. A 204 or
// lost response is unknown, never permission to dispatch again. The returned
// receipt means a matching run was observed, not that its stage was admitted.
export class WakeDispatcher {
  #reader; #token; #observe; #journal; #fetch;
  constructor({ token, observe, journal, fetcher = fetch }) {
    requireThat(typeof token === 'string' && token.trim() && typeof observe === 'function' && typeof journal?.run === 'function', 'INVALID_WAKE_ADAPTER');
    this.#reader = new GitHubReader(token, fetcher); this.#token = token;
    this.#observe = observe; this.#journal = journal; this.#fetch = fetcher;
  }
  async dispatch() {
    let initial;
    try { initial = await this.#observe(this.#reader); } catch { return { status: 'denied', code: 'WAKE_OBSERVATION_UNAVAILABLE' }; }
    const bindingHash = digest(initial), { issue, workflow } = initial;
    let runId;
    const result = await this.#journal.run({ operation: 'wake', bindingHash }, {
      admit: async () => {
        requireThat(digest(await this.#observe(this.#reader)) === bindingHash, 'WAKE_ADMISSION_CHANGED'); return bindingHash;
      },
      perform: async () => {
        const response = await this.#fetch(`https://api.github.com${repoPath(issue.repository)}/actions/workflows/${workflow.id}/dispatches`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
          headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2026-03-10' },
          body: JSON.stringify({ ref: workflow.ref, inputs: { issue_number: String(issue.number), issue_id: issue.id,
            repository_id: String(issue.repositoryId) } }),
        });
        requireThat(response.status === 200, 'DISPATCH_RESULT_UNKNOWN');
        const receipt = await response.json(); runId = receipt.workflow_run_id;
        requireThat(isId(runId) && receipt.run_url === `https://api.github.com${repoPath(issue.repository)}/actions/runs/${runId}` &&
          receipt.html_url === `https://github.com/${issue.repository}/actions/runs/${runId}`, 'DISPATCH_IDENTITY_UNKNOWN');
      },
      readBack: async () => {
        const run = await this.#reader.get(`${repoPath(issue.repository)}/actions/runs/${runId}`);
        requireThat(run.id === runId && run.event === 'workflow_dispatch' && run.workflow_id === workflow.id && run.path === workflow.path &&
          run.repository?.id === issue.repositoryId && run.head_repository?.id === issue.repositoryId && run.head_sha === workflow.commit &&
          run.head_branch === workflow.ref && run.actor?.id === initial.actorId && run.run_attempt === 1, 'DISPATCH_RUN_MISMATCH');
        return bindingHash;
      },
    });
    return result.status === 'completed' ? { status: 'scheduled', runId, bindingHash, stageAdmitted: false } : result;
  }
}

// Read the live reverse edge list; do not save a parallel dependency graph or
// discover arbitrary configuration from downstream Issue text.
export async function fanout(reader, upstream, { approvedTarget, wake }) {
  const verifyClosed = async () => {
    const repository = await reader.repository(upstream.repository), issue = await reader.issue(upstream);
    requireThat(repository.id === upstream.repositoryId && repository.full_name === upstream.repository && repository.private === false &&
      issue.node_id === upstream.id && issue.number === upstream.number && !issue.pull_request && issue.state === 'closed' &&
      issue.url === `https://api.github.com/repos/${upstream.repository}/issues/${upstream.number}`, 'UPSTREAM_NOT_CLOSED');
    requireThat(isDeliveredIssue(issue), 'UPSTREAM_NOT_DELIVERED');
  };
  await verifyClosed();
  const before = await reader.blocking(upstream), seen = new Set(), targets = [];
  for (const edge of before) {
    requireThat(typeof edge.node_id === 'string' && !seen.has(edge.node_id) && !edge.pull_request, 'INVALID_FANOUT_EDGE');
    seen.add(edge.node_id);
    const target = await approvedTarget(edge.node_id);
    if (!target) continue;
    requireThat(edge.number === target.number && edge.url === `https://api.github.com/repos/${target.repository}/issues/${target.number}`, 'FANOUT_IDENTITY_CHANGED');
    const reverse = await reader.blockedBy(target);
    requireThat(reverse.some(item => item.node_id === upstream.id && item.url === `https://api.github.com/repos/${upstream.repository}/issues/${upstream.number}`), 'FANOUT_EDGE_CHANGED');
    targets.push(target);
  }
  requireThat(digest(await reader.blocking(upstream)) === digest(before), 'FANOUT_GRAPH_CHANGED');
  const results = [];
  for (const target of targets) { await verifyClosed(); results.push({ issueId: target.id, result: await wake(target) }); }
  return results;
}
