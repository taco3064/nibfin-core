// Selective adaptation of Kairo's GitHub reader. No writes or offline fallback.
export function repoPath(repository) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
      repository.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('Invalid repository identity');
  }
  return `/repos/${repository}`;
}

export function issuePath(issue) {
  if (!Number.isSafeInteger(issue?.number) || issue.number < 1) throw new Error('Invalid Issue number');
  return `${repoPath(issue.repository)}/issues/${issue.number}`;
}

export class GitHubReader {
  #token;
  #fetch;
  constructor(token, fetcher = fetch) {
    if (typeof token !== 'string' || !token.trim()) throw new Error('Authenticated GitHub reader required');
    this.#token = token;
    this.#fetch = fetcher;
  }
  async get(path) {
    if (typeof path !== 'string' || !path.startsWith('/repos/') || /[\\\r\n#]/.test(path) ||
        path.split('?')[0].split('/').some(part => part === '..' || part === '.')) {
      throw new Error('Invalid GitHub resource path');
    }
    const response = await this.#fetch(`https://api.github.com${path}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${this.#token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) throw Object.assign(new Error(`GitHub read failed: HTTP ${response.status}`), { status: response.status });
    return response.json();
  }
  async list(path) {
    const result = [];
    for (let page = 1; page <= 100; page++) {
      const values = await this.get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(values)) throw new Error('Invalid paginated GitHub response');
      result.push(...values);
      if (values.length < 100) return result;
    }
    throw new Error('GitHub pagination limit exceeded');
  }
  repository(name) { return this.get(repoPath(name)); }
  issue(issue) { return this.get(issuePath(issue)); }
  blockedBy(issue) { return this.list(`${issuePath(issue)}/dependencies/blocked_by`); }
  blocking(issue) { return this.list(`${issuePath(issue)}/dependencies/blocking`); }
}
