// Selective adaptation of Kairo's GitHub reader. No writes or offline fallback.
import { fetchGitHubRead, retryableGitHubStatus } from './github-read-retry.mjs';

export function repoPath(repository) {
  if (typeof repository !== 'string' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      repository.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Invalid repository identity');
  }
  return `/repos/${repository}`;
}

export function issuePath(issue) {
  if (!Number.isSafeInteger(issue?.number) || issue.number < 1)
    throw new Error('Invalid Issue number');
  return `${repoPath(issue.repository)}/issues/${issue.number}`;
}

export class GitHubReader {
  #token;
  #fetch;
  constructor(token, fetcher = fetch) {
    if (typeof token !== 'string' || !token.trim())
      throw new Error('Authenticated GitHub reader required');
    this.#token = token;
    this.#fetch = fetcher;
  }
  async get(path, { retryNotFound = false } = {}) {
    if (typeof path !== 'string' || !(path.startsWith('/repos/') || path === '/user') ||
        /[\\\r\n#]/.test(path) ||
        path.split('?')[0].split('/').some(part => part === '..' || part === '.')) {
      throw new Error('Invalid GitHub resource path');
    }
    const response = await fetchGitHubRead(this.#fetch, `https://api.github.com${path}`, {
      method: 'GET', redirect: 'error',
      headers: {
        Authorization: `Bearer ${this.#token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, { retryNotFound });
    if (!response.ok) {
      const status = response.status;
      throw Object.assign(new Error(`GitHub read failed: HTTP ${status}`), {
        status,
        transientGitHubRead: retryableGitHubStatus(response),
        retryAfter: response.headers?.get('retry-after'),
        rateLimitReset: response.headers?.get('x-ratelimit-remaining') === '0'
          ? response.headers.get('x-ratelimit-reset') : null,
        requestId: response.headers?.get('x-github-request-id'),
        resource: path.split('?')[0],
      });
    }
    return response.json();
  }
  async list(path, key) {
    const result = [];
    for (let page = 1; page <= 100; page++) {
      const query = `per_page=100&page=${page}`;
      const response = await this.get(`${path}${path.includes('?') ? '&' : '?'}${query}`);
      const values = key === undefined ? response : response?.[key];
      const count = response?.total_count;
      if (key !== undefined &&
          (!Number.isSafeInteger(count) || count < 0 || count > 1000)) {
        throw new Error('Incomplete object pagination');
      }
      if (!Array.isArray(values)) throw new Error('Invalid paginated GitHub response');
      result.push(...values);
      if (values.length < 100) {
        if (key !== undefined && result.length !== count)
          throw new Error('Object pagination changed or was truncated');
        return result;
      }
    }
    throw new Error('GitHub pagination limit exceeded');
  }
  async jobLogs(repository, jobId) {
    if (!Number.isSafeInteger(jobId) || jobId < 1)
      throw new Error('Invalid job identity');
    const path = `${repoPath(repository)}/actions/jobs/${jobId}/logs`;
    const url = `https://api.github.com${path}`;
    const response = await fetchGitHubRead(this.#fetch, url, {
      method: 'GET', redirect: 'manual',
      headers: {
        Authorization: `Bearer ${this.#token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (response.status !== 302) throw new Error('Job log redirect unavailable');
    const location = new URL(response.headers.get('location'));
    if (location.protocol !== 'https:' || location.username || location.password ||
        location.port || !location.hostname.endsWith('.blob.core.windows.net'))
      throw new Error('Untrusted job log origin');
    const logs = await fetchGitHubRead(this.#fetch, location.href, {
      method: 'GET', redirect: 'error',
    });
    if (!logs.ok || !logs.body) throw new Error('Job logs unavailable');
    const chunks = []; let size = 0;
    for await (const chunk of logs.body) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw new Error('Job log size limit exceeded');
      chunks.push(chunk);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  }
  repository(name) { return this.get(repoPath(name)); }
  issue(issue) { return this.get(issuePath(issue)); }
  blockedBy(issue) { return this.list(`${issuePath(issue)}/dependencies/blocked_by`); }
  blocking(issue) { return this.list(`${issuePath(issue)}/dependencies/blocking`); }
}
