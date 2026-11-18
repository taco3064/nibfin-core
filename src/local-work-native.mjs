import { GitHubReader } from './github-read.mjs';
import { limits } from './local-work-values.mjs';
import { requireThat } from './identity.mjs';

// Use the established authenticated GET path, with tighter observation budgets.
// The fetch wrapper bounds bytes before GitHubReader parses any response.
export function observationReader(token, fetcher = fetch) {
  const deadline = Date.now() + limits.milliseconds;
  let requests = 0;
  const reader = new GitHubReader(token, async (url, options) => {
    requireThat(++requests <= limits.requests && Date.now() < deadline,
      'OBSERVATION_LIMIT');
    let response;
    try {
      response = await fetcher(url, { ...options,
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
    } catch { requireThat(false, 'OBSERVATION_LIMIT'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error('Native observation unavailable'),
        { status: response.status });
    }
    const chunks = []; let size = 0;
    for await (const bytes of response.body) {
      size += bytes.length;
      if (size > limits.responseBytes || Date.now() >= deadline) {
        requireThat(false, 'OBSERVATION_LIMIT');
      }
      chunks.push(bytes);
    }
    return new Response(Buffer.concat(chunks), {
      status: response.status, headers: response.headers,
    });
  });
  return reader;
}

export async function boundedList(reader, path, key) {
  const values = [];
  for (let page = 1; page <= limits.pages; page++) {
    const separator = path.includes('?') ? '&' : '?';
    const result = await reader.get(
      `${path}${separator}per_page=${limits.items}&page=${page}`,
    );
    const items = key ? result?.[key] : result;
    requireThat(Array.isArray(items) && items.length <= limits.items,
      'OBSERVATION_LIMIT');
    values.push(...items);
    if (items.length < limits.items) {
      requireThat(!key || result.total_count === values.length, 'OBSERVATION_LIMIT');
      return values;
    }
  }
  requireThat(false, 'OBSERVATION_LIMIT');
}
