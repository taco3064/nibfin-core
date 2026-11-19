import contract from './core-rollout-result.json' with { type: 'json' };

const networkErrors = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
]);

export const githubApiWaiting = 'GITHUB_API_RETRY_PENDING';

export function networkGitHubRead(error) {
  return error?.name === 'TimeoutError' ||
    networkErrors.has(error?.cause?.code ?? error?.code);
}

// Only errors marked at the maintained read boundary are API observations.
// This deliberately carries no URL, response body, message, headers or token.
export function safeGitHubReadCause(error) {
  if (error?.githubApiRead !== true) return null;
  const saved = error.githubApiCause;
  if (saved?.kind === 'http' && Number.isInteger(saved.httpStatus))
    return { kind: 'http', httpStatus: saved.httpStatus };
  if (saved?.kind !== 'http' && contract.githubCauseKinds.includes(saved?.kind))
    return { kind: saved.kind };
  if (error.githubReadFailure === 'invalid-response' || error instanceof SyntaxError)
    return { kind: 'invalid-response' };
  if (Number.isInteger(error.status)) return { kind: 'http', httpStatus: error.status };
  if (error.githubReadFailure === 'network' || networkGitHubRead(error))
    return { kind: 'network' };
  return { kind: 'read' };
}

export function githubReadDiagnostic(error) {
  const githubApi = safeGitHubReadCause(error);
  return githubApi ? { code: githubApiWaiting, githubApi } : null;
}

export function preserveGitHubReadCause(error) {
  const githubApiCause = safeGitHubReadCause(error);
  if (!githubApiCause) return {};
  return { githubApiRead: true, githubApiCause,
    ...(githubApiCause.kind === 'http' ? { status: githubApiCause.httpStatus } : {}) };
}
