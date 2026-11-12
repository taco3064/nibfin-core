import { setTimeout } from 'node:timers/promises';

const networkErrors = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
]);

export function transientGitHubRead(error) {
  return error?.transientGitHubRead === true;
}

export function retryableGitHubStatus(response) {
  const status = response.status;
  return status >= 500 && status <= 504 || rateLimited(response);
}

function rateLimited(response) {
  return response.status === 429 || response.status === 403 &&
    (response.headers?.get('x-ratelimit-remaining') === '0' ||
      Boolean(response.headers?.get('retry-after')));
}

function retryDelay(response, retryNotFound, attempt) {
  const fallback = 500 * 2 ** attempt;
  const status = response.status;
  const headers = response.headers;
  const retryAfter = headers?.get?.('retry-after');
  const exhausted = headers?.get?.('x-ratelimit-remaining') === '0';
  if (rateLimited(response)) {
    if (retryAfter && /^\d+$/.test(retryAfter))
      return Math.max(fallback, Number(retryAfter) * 1000);
    const reset = headers?.get?.('x-ratelimit-reset');
    if (exhausted && reset && /^\d+$/.test(reset))
      return Math.max(fallback, Number(reset) * 1000 - Date.now() + 1000);
    return 60000;
  }
  return status >= 500 && status <= 504 || status === 404 && retryNotFound
    ? fallback : null;
}

export async function fetchGitHubRead(fetcher, url, options, {
  retryNotFound = false, wait = setTimeout,
} = {}) {
  let waitBudget = 60000;
  for (let attempt = 0; ; attempt++) {
    let delay, result;
    try {
      result = await fetcher(url, { ...options, signal: AbortSignal.timeout(30000) });
      delay = retryDelay(result, retryNotFound, attempt);
      if (delay === null || attempt === 2 || delay > waitBudget) return result;
    } catch (error) {
      const transient = error.name === 'TimeoutError' ||
        networkErrors.has(error.cause?.code ?? error.code);
      if (!transient) throw error;
      if (attempt === 2) {
        throw Object.assign(error, { transientGitHubRead: true });
      }
      delay = 500 * 2 ** attempt;
      if (delay > waitBudget) throw error;
    }
    await result?.body?.cancel?.();
    await wait(delay);
    waitBudget -= delay;
  }
}
