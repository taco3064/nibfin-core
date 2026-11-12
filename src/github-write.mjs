import { repoPath, issuePath } from './github-read.mjs';
import { digest, isDigest, isId, isSha, requireThat } from './identity.mjs';
import { readMergeIdentity } from './github-merge.mjs';

export class MergeBeforeWrite extends Error {
  constructor(code = 'MERGE_REOBSERVE_REQUIRED') {
    super(code);
    this.code = code;
  }
}

function labels(issue) {
  requireThat(
    Array.isArray(issue.labels) &&
      issue.labels.every((label) => typeof label.name === 'string' && label.name),
    'INVALID_LIVE_LABELS',
  );
  const names = issue.labels.map((label) => label.name).sort();
  requireThat(new Set(names).size === names.length, 'DUPLICATE_LIVE_LABELS');
  return names;
}
function issueMatches(remote, expected) {
  requireThat(
    remote?.node_id === expected.id &&
      remote.number === expected.number &&
      !remote.pull_request &&
      remote.url === `https://api.github.com${issuePath(expected)}`,
    'ISSUE_WRITE_IDENTITY_MISMATCH',
  );
}

// Trusted Core only. Every method must run inside the durable operation journal.
// The fresh guard checks the exact operation + target/body digest immediately
// before the single HTTP mutation. No redirect, retry or response-body logging.
export class GitHubWriter {
  #reader;
  #token;
  #guard;
  #fetch;
  constructor({ reader, token, guard, fetcher = fetch }) {
    requireThat(
      typeof reader?.get === 'function' &&
        typeof token === 'string' &&
        token.trim() &&
        typeof guard === 'function' &&
        typeof fetcher === 'function',
      'INVALID_WRITE_ADAPTER',
    );
    this.#reader = reader;
    this.#token = token;
    this.#guard = guard;
    this.#fetch = fetcher;
  }
  async #write(operation, method, path, body, settlementLabel) {
    const targetHash = digest({ operation, method, path, body: body ?? null });
    const admission = await this.#guard({ operation, targetHash,
      ...(settlementLabel ? { settlementLabel } : {}) });
    requireThat(
      admission?.targetHash === targetHash && isDigest(admission.bindingHash),
      'WRITE_ADMISSION_DENIED',
    );
    let response;
    try {
      response = await this.#fetch(`https://api.github.com${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify(body),
      });
      if (operation === 'merge' && response.status === 403)
        throw new MergeBeforeWrite('GITHUB_MERGE_FORBIDDEN');
      if (operation === 'merge' && response.status === 405)
        throw new MergeBeforeWrite('GITHUB_MERGE_BLOCKED');
      if (operation === 'merge' && response.status === 409) throw new MergeBeforeWrite();
      requireThat(response.ok, 'GITHUB_WRITE_NOT_CONFIRMED');
      return await response.json();
    } catch (error) {
      if (error instanceof MergeBeforeWrite) throw error;
      throw Object.assign(new Error('External effect requires reconciliation'), {
        code: 'EXTERNAL_EFFECT_UNKNOWN',
      });
    }
  }
  async #issue(expected, expectedBodyHash, expectedLabels, allowClosed = false) {
    requireThat(
      isId(expected?.repositoryId) &&
        isDigest(expectedBodyHash) &&
        Array.isArray(expectedLabels),
      'INVALID_ISSUE_WRITE',
    );
    const repository = await this.#reader.repository(expected.repository);
    requireThat(
      repository.id === expected.repositoryId &&
        repository.full_name === expected.repository &&
        repository.private === false,
      'REPOSITORY_WRITE_IDENTITY_MISMATCH',
    );
    const current = await this.#reader.issue(expected);
    issueMatches(current, expected);
    requireThat(
      (current.state === 'open' || allowClosed && current.state === 'closed') &&
        digest(current.body) === expectedBodyHash &&
        digest(labels(current).filter(name => name !== 'pause')) ===
          digest(expectedLabels.filter(name => name !== 'pause').sort()),
      'STALE_ISSUE_WRITE',
    );
    return current;
  }
  async repairPause({ issue, expectedBodyHash, expectedLabels, desired }) {
    requireThat(typeof desired === 'boolean' &&
      expectedLabels.includes('pause') !== desired, 'INVALID_PAUSE_REPAIR');
    const before = await this.#issue(issue, expectedBodyHash, expectedLabels, true);
    requireThat(labels(before).includes('pause') !== desired, 'STALE_PAUSE_REPAIR');
    // Native membership endpoints preserve unrelated labels under races.
    const path = issuePath(issue) + '/labels';
    await this.#write('repair-pause', desired ? 'POST' : 'DELETE',
      desired ? path : path + '/pause', desired ? { labels: ['pause'] } : undefined);
    const after = await this.#reader.issue(issue);
    issueMatches(after, issue);
    const unrelated = names => names.filter(name => name !== 'pause');
    requireThat(after.state === before.state &&
      digest(after.body) === expectedBodyHash &&
      labels(after).includes('pause') === desired &&
      digest(unrelated(labels(after))) === digest(unrelated(labels(before))),
    'PAUSE_REPAIR_READBACK_UNKNOWN');
    return { reference: after.url };
  }
  async confirmShape({ issue, expectedBodyHash, expectedLabels, body }) {
    requireThat(
      digest(body) === expectedBodyHash &&
        expectedLabels.includes('shaped') &&
        expectedLabels.includes('scope') &&
        !expectedLabels.includes('delivered'),
      'INVALID_SHAPE_REVALIDATION',
    );
    // The guard checks the current Shape and its independent validation.
    // Confirm publication without making a GitHub write.
    const targetHash = digest({
      operation: 'publish-shape',
      method: 'GET',
      path: issuePath(issue),
      body,
    });
    const admission = await this.#guard({
      operation: 'publish-shape',
      targetHash,
    });
    requireThat(
      admission?.targetHash === targetHash && isDigest(admission.bindingHash),
      'WRITE_ADMISSION_DENIED',
    );
    const current = await this.#issue(issue, expectedBodyHash, expectedLabels);
    return { bodyHash: digest(current.body), reference: current.url };
  }
  async #addLifecycleLabel(operation, issue, current, name, code) {
    // Membership writes cannot overwrite a concurrent pause or Resume.
    await this.#write(operation, 'POST', issuePath(issue) + '/labels', {
      labels: [name],
    });
    const actual = await this.#reader.issue(issue);
    issueMatches(actual, issue);
    const stable = value => labels(value).filter(label => label !== 'pause');
    requireThat(actual.state === current.state && actual.body === current.body &&
      digest(stable(actual)) === digest([...stable(current), name].sort()), code);
  }
  async publishShape({ issue, expectedBodyHash, expectedLabels, body }) {
    requireThat(typeof body === 'string' && body.trim(), 'EMPTY_SHAPE');
    const current = await this.#issue(issue, expectedBodyHash, expectedLabels);
    const names = labels(current);
    requireThat(
      names.includes('scope') &&
        !names.includes('shaped') &&
        !names.includes('delivered'),
      'INVALID_SHAPE_TRANSITION',
    );
    const desired = [...names, 'shaped'].sort();
    await this.#addLifecycleLabel(
      'publish-shape', issue, current, 'shaped', 'SHAPE_READBACK_UNKNOWN',
    );
    await this.#write('publish-shape', 'PATCH', issuePath(issue), { body }, 'shaped');
    const actual = await this.#reader.issue(issue);
    issueMatches(actual, issue);
    requireThat(
      actual.state === 'open' &&
        actual.body === body &&
        digest(labels(actual).filter(name => name !== 'pause')) ===
          digest(desired.filter(name => name !== 'pause')),
      'SHAPE_READBACK_UNKNOWN',
    );
    return { bodyHash: digest(body), reference: actual.url };
  }
  async createPullRequest({
    repository,
    repositoryId,
    headBranch,
    head,
    baseBranch,
    base,
    title,
    body,
  }) {
    requireThat(
      isId(repositoryId) &&
        isSha(head) &&
        isSha(base) &&
        /^nibfin\/issue-[1-9]\d*-[a-f0-9]{12}$/.test(headBranch) &&
        typeof baseBranch === 'string' &&
        baseBranch &&
        typeof title === 'string' &&
        title.trim() &&
        typeof body === 'string' &&
        body.trim(),
      'INVALID_PR_PUBLICATION',
    );
    const root = repoPath(repository),
      repo = await this.#reader.repository(repository);
    requireThat(
      repo.id === repositoryId &&
        repo.full_name === repository &&
        repo.private === false &&
        repo.default_branch === baseBranch,
      'PR_REPOSITORY_CHANGED',
    );
    const actualHead = await this.#reader.get(
      `${root}/branches/${encodeURIComponent(headBranch)}`,
    );
    const actualBase = await this.#reader.get(
      `${root}/branches/${encodeURIComponent(baseBranch)}`,
    );
    requireThat(
      actualHead.commit?.sha === head &&
        isSha(actualBase.commit?.sha) &&
        actualBase.protected === true,
      'PR_BRANCH_IDENTITY_CHANGED',
    );
    const response = await this.#write('commit-pr', 'POST', `${root}/pulls`, {
      title,
      body,
      head: headBranch,
      base: baseBranch,
      draft: false,
    });
    requireThat(
      isId(response.number) &&
        typeof response.node_id === 'string' &&
        response.node_id,
      'PR_RESPONSE_UNKNOWN',
    );
    const pr = await this.#reader.get(`${root}/pulls/${response.number}`);
    requireThat(
      pr.node_id === response.node_id &&
        pr.number === response.number &&
        pr.state === 'open' &&
        pr.draft === false &&
        pr.head?.sha === head &&
        pr.head.ref === headBranch &&
        pr.head.repo?.id === repositoryId &&
        isSha(pr.base?.sha) &&
        pr.base.ref === baseBranch &&
        pr.base.repo?.id === repositoryId &&
        pr.body === body &&
        pr.title === title,
      'PR_READBACK_UNKNOWN',
    );
    return {
      id: pr.node_id,
      number: pr.number,
      head,
      base,
      reference: `https://github.com/${repository}/pull/${pr.number}`,
    };
  }
  async merge({
    repository,
    repositoryId,
    number,
    id,
    head,
    base,
    baseBranch,
    testMerge,
    candidateBase = base,
    nativePolicy = false,
  }) {
    requireThat(
      isId(repositoryId) &&
        isId(number) &&
        typeof id === 'string' &&
        id &&
        isSha(head) &&
        isSha(base) &&
        typeof baseBranch === 'string' &&
        baseBranch,
      'INVALID_MERGE_TARGET',
    );
    const root = repoPath(repository),
      path = `${root}/pulls/${number}`;
    const current = await this.#reader.get(path);
    requireThat(
      current.node_id === id &&
        current.number === number &&
        current.state === 'open' &&
        current.draft === false &&
        current.merged === false &&
        current.head?.sha === head &&
        current.head.repo?.id === repositoryId &&
        current.base?.ref === baseBranch &&
        current.base.repo?.id === repositoryId,
      'STALE_OR_BLOCKED_MERGE',
    );
    if (current.base.sha !== base || current.mergeable !== true ||
      (!nativePolicy && current.mergeable_state !== 'clean')) {
      throw new MergeBeforeWrite();
    }
    const branch = await this.#reader.get(
      `${root}/branches/${encodeURIComponent(baseBranch)}`,
    );
    requireThat(nativePolicy || branch.protected === true, 'MERGE_PROTECTION_CHANGED');
    if (branch.commit?.sha !== base) throw new MergeBeforeWrite();
    const repositoryState = await this.#reader.repository(repository);
    requireThat(
      repositoryState.id === repositoryId &&
        repositoryState.full_name === repository &&
        repositoryState.private === false &&
        repositoryState.default_branch === baseBranch,
      'MERGE_REPOSITORY_CHANGED',
    );
    const method =
      repositoryState.allow_merge_commit === true
        ? 'merge'
        : repositoryState.allow_rebase_merge === true
          ? 'rebase'
          : undefined;
    requireThat(method, 'UNSUPPORTED_MERGE_METHOD');
    if (method === 'rebase') {
      const source = await this.#reader.get(`${root}/git/commits/${head}`);
      requireThat(
        source?.sha === head &&
          source.parents?.length === 1 &&
          source.parents[0].sha === candidateBase &&
          isSha(source.tree?.sha),
        'SINGLE_COMMIT_REBASE_REQUIRED',
      );
    }
    const response = await this.#write('merge', 'PUT', `${path}/merge`, {
      sha: head,
      merge_method: method,
    });
    requireThat(
      response.merged === true && isSha(response.sha),
      'MERGE_RESPONSE_UNKNOWN',
    );
    const actual = await this.#reader.get(path);
    requireThat(
      actual.node_id === id &&
        actual.number === number &&
        actual.state === 'closed' &&
        actual.merged === true &&
        actual.head?.sha === head &&
        actual.head.repo?.id === repositoryId &&
        actual.base?.repo?.id === repositoryId &&
        actual.merge_commit_sha === response.sha,
      'MERGE_READBACK_UNKNOWN',
    );
    const identity = await readMergeIdentity(
      this.#reader,
      root,
      { head, base, merge: response.sha, testMerge },
      'MERGE_ANCESTRY_UNKNOWN',
    );
    requireThat(
      identity === (method === 'merge' ? 'merge' : 'rewrite'),
      'MERGE_METHOD_UNKNOWN',
    );
    return {
      mergeCommit: response.sha,
      reference: `https://github.com/${repository}/pull/${number}`,
    };
  }
  async closeDelivered({ issue, expectedBodyHash, expectedLabels }) {
    const current = await this.#issue(issue, expectedBodyHash, expectedLabels);
    const names = labels(current);
    requireThat(
      names.includes('scope') &&
        names.includes('shaped') &&
        !names.includes('delivered'),
      'INVALID_CLOSURE_TRANSITION',
    );
    const desired = [...names, 'delivered'].sort();
    await this.#addLifecycleLabel(
      'close', issue, current, 'delivered', 'CLOSURE_READBACK_UNKNOWN',
    );
    await this.#write('close', 'PATCH', issuePath(issue), {
      state: 'closed',
      state_reason: 'completed',
    }, 'delivered');
    const actual = await this.#reader.issue(issue);
    issueMatches(actual, issue);
    requireThat(
      actual.state === 'closed' &&
        actual.state_reason === 'completed' &&
        digest(actual.body) === expectedBodyHash &&
        digest(labels(actual).filter(name => name !== 'pause')) ===
          digest(desired.filter(name => name !== 'pause')),
      'CLOSURE_READBACK_UNKNOWN',
    );
    return { reference: actual.url, bodyHash: expectedBodyHash };
  }
}
