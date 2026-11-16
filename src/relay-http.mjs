import { GitHubReader, repoPath } from './github-read.mjs';
import { requireThat } from './identity.mjs';

export const relayBounds = Object.freeze({
  interval: 60000, window: 86400000, pages: 3, pageSize: 50,
  responseBytes: 1048576, archiveBytes: 65536, timeout: 15000, requests: 240,
});

export async function boundedBody(response, limit) {
  const chunks = []; let size = 0;
  try {
    const declared = response.headers.get('content-length');
    requireThat(!declared || /^\d+$/.test(declared) && Number(declared) <= limit,
      'RELAY_RESPONSE_TOO_LARGE');
    requireThat(!response.headers.get('content-encoding') ||
      response.headers.get('content-encoding') === 'identity',
    'RELAY_COMPRESSED_HTTP_RESPONSE');
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      requireThat(size <= limit, 'RELAY_RESPONSE_TOO_LARGE');
      chunks.push(chunk);
    }
  } catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  return Buffer.concat(chunks);
}

// All relay reads, including downstream routing reads, share one request budget.
// Conditional responses are used only for discovery, never write admission.
export class RelayReader extends GitHubReader {
  #token; #fetch; #remaining = relayBounds.requests;
  constructor(token, fetcher = fetch) {
    super(token, fetcher);
    this.#token = token; this.#fetch = fetcher;
  }
  async request(path, { etag, redirect = 'error' } = {}) {
    requireThat(typeof path === 'string' &&
      (path === '/user' || path.startsWith('/repos/')) &&
      !/[\\\r\n#]/.test(path) &&
      !path.split('?')[0].split('/').some(part => ['.', '..'].includes(part)),
    'INVALID_RELAY_RESOURCE');
    requireThat(this.#remaining-- > 0, 'RELAY_REQUEST_BUDGET');
    requireThat(!etag || /^"[A-Za-z0-9_-]{1,128}"$/.test(etag), 'INVALID_RELAY_ETAG');
    const response = await this.#fetch(`https://api.github.com${path}`, {
      method: 'GET', redirect, signal: AbortSignal.timeout(relayBounds.timeout),
      headers: { Authorization: `Bearer ${this.#token}`,
        Accept: 'application/vnd.github+json', 'Accept-Encoding': 'identity',
        'X-GitHub-Api-Version': '2026-03-10',
        ...(etag ? { 'If-None-Match': etag } : {}) },
    });
    if (response.status === 304 || redirect === 'manual' && response.status === 302) {
      await response.body?.cancel();
      return { response };
    }
    if (!response.ok) {
      await response.body?.cancel();
      const seconds = Number(response.headers.get('retry-after'));
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      throw Object.assign(new Error('RELAY_HTTP_UNAVAILABLE'), {
        code: 'RELAY_HTTP_UNAVAILABLE', status: response.status,
        backoff: Math.min(86400000, Math.max(60000,
          Number.isFinite(seconds) ? seconds * 1000 : 0,
          Number.isFinite(reset) ? reset - Date.now() : 0)),
      });
    }
    const bytes = await boundedBody(response, relayBounds.responseBytes);
    return { response, value: JSON.parse(new TextDecoder('utf-8',
      { fatal: true }).decode(bytes)) };
  }
  async get(path) { return (await this.request(path)).value; }
  async list(path, key) {
    const result = [];
    for (let page = 1; page <= relayBounds.pages; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const { value, response } = await this.request(path + separator +
        `per_page=${relayBounds.pageSize}&page=${page}`);
      const values = key === undefined ? value : value?.[key];
      requireThat(Array.isArray(values) && values.length <= relayBounds.pageSize,
        'RELAY_INCOMPLETE_LISTING');
      result.push(...values);
      const next = /rel="next"/.test(response.headers.get('link') ?? '');
      if (values.length < relayBounds.pageSize && !next) {
        requireThat(key === undefined || value.total_count === result.length,
          'RELAY_INCOMPLETE_LISTING');
        return result;
      }
    }
    requireThat(false, 'RELAY_INCOMPLETE_LISTING');
  }
  async discovery(origin, since, etag) {
    const path = `${repoPath(origin.repository)}/actions/workflows/` +
      `${origin.workflow.id}/runs?event=issues&created=%3E%3D${since}` +
      `&per_page=${relayBounds.pageSize}&page=1`;
    const first = await this.request(path, { etag });
    if (first.response.status === 304) return { unchanged: true };
    const runs = first.value?.workflow_runs;
    requireThat(Array.isArray(runs) && runs.length <= relayBounds.pageSize &&
      Number.isSafeInteger(first.value.total_count) && first.value.total_count >= 0,
    'RELAY_INCOMPLETE_LISTING');
    const found = [...runs];
    for (let page = 2; page <= relayBounds.pages &&
      found.length < first.value.total_count; page++) {
      const value = await this.get(path.replace('page=1', `page=${page}`));
      requireThat(Array.isArray(value.workflow_runs) &&
        value.workflow_runs.length <= relayBounds.pageSize,
      'RELAY_INCOMPLETE_LISTING');
      found.push(...value.workflow_runs);
    }
    // A discovery window is deliberately bounded. It cannot establish absence.
    const tag = first.response.headers.get('etag');
    return { runs: found, etag: /^"[A-Za-z0-9_-]{1,128}"$/.test(tag ?? '')
      ? tag : null, complete: found.length === first.value.total_count };
  }
}

export async function downloadRelayArtifact(reader, repository, id, fetcher = fetch) {
  const { response } = await reader.request(
    `${repoPath(repository)}/actions/artifacts/${id}/zip`, { redirect: 'manual' });
  requireThat(response.status === 302, 'RELAY_ARTIFACT_REDIRECT_REQUIRED');
  let location = response.headers.get('location');
  for (let hop = 0; hop < 3; hop++) {
    const url = new URL(location);
    requireThat(url.protocol === 'https:' && !url.username && !url.password &&
      !url.port && !url.hash && url.href.length <= 8192 &&
      (url.hostname.endsWith('.blob.core.windows.net') ||
        url.hostname === 'productionresultssa0.blob.core.windows.net'),
    'RELAY_UNSAFE_ARTIFACT_DESTINATION');
    // Never forward the API Authorization header to storage, even on redirects.
    const stored = await fetcher(url, { method: 'GET', redirect: 'manual',
      signal: AbortSignal.timeout(relayBounds.timeout),
      headers: { 'Accept-Encoding': 'identity' } });
    if ([301, 302, 303, 307, 308].includes(stored.status)) {
      location = new URL(stored.headers.get('location'), url).href;
      await stored.body?.cancel();
      continue;
    }
    if (stored.status !== 200) {
      await stored.body?.cancel();
      requireThat(false, 'RELAY_ARTIFACT_UNAVAILABLE');
    }
    return boundedBody(stored, relayBounds.archiveBytes);
  }
  requireThat(false, 'RELAY_ARTIFACT_REDIRECT_LIMIT');
}
