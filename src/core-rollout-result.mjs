import { projectPackageCleanup } from './core-package-retirement-contract.mjs';
import contract from './core-rollout-result.json' with { type: 'json' };
import { githubReadDiagnostic, safeGitHubReadCause } from './github-read-cause.mjs';

const safeCode = code => typeof code === 'string' &&
  new RegExp(contract.codePattern).test(code);

export function rolloutFailure(error) {
  const diagnostic = githubReadDiagnostic(error);
  if (diagnostic) return { status: 'pending', ...diagnostic };
  const code = safeCode(error?.code) ? error.code : contract.fallbackCode;
  return { status: contract.deniedCodes.includes(code) ? 'denied' : 'pending', code };
}

export function rolloutResultExit(result) {
  return (Object.hasOwn(contract.failureExitCodes, result?.status) ?
    contract.failureExitCodes[result.status] : undefined) ??
    (contract.successStatuses.includes(result?.status) ? 0 : undefined);
}

function apiProjection(value) {
  if (!contract.githubCauseKinds.includes(value?.kind) ||
    value.kind === 'http' && !Number.isInteger(value.httpStatus)) return undefined;
  return safeGitHubReadCause({ githubApiRead: true, githubApiCause: value });
}

function resultRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const [key, pattern] of Object.entries(contract.recordStringPatterns)) {
    if (typeof value[key] === 'string' && new RegExp(pattern).test(value[key]))
      result[key] = value[key];
  }
  for (const key of contract.recordIntegerFields) {
    if (Number.isSafeInteger(value[key]) && value[key] > 0) result[key] = value[key];
  }
  if (contract.recordStatuses.includes(value.status)) result.status = value.status;
  if (safeCode(value.code)) result.code = value.code;
  const api = apiProjection(value.githubApi);
  if (api) result.githubApi = api;
  return Object.keys(result).length ? result : null;
}

const resultsProjection = values => values.map(resultRecord).filter(Boolean);

// Only the existing typed diagnostic fields cross failure process boundaries.
// Additional messages, provider URLs/bodies, headers and credentials are dropped.
export function projectRolloutResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    rolloutResultExit(value) === undefined) return null;
  if (Object.hasOwn(contract.failureExitCodes, value.status)) {
    if (value.status !== 'pending' && !safeCode(value.code)) return null;
    const result = { status: value.status };
    if (safeCode(value.code)) result.code = value.code;
    const api = apiProjection(value.githubApi);
    if (api) result.githubApi = api;
    if (['complete', 'pending', 'unsupported'].includes(value.installation))
      result.installation = value.installation;
    if (value.code === 'UPGRADE_CORE_ACTIVATION_QUEUED' &&
      Number.isSafeInteger(value.coreRunId) && value.coreRunId > 0 &&
      typeof value.coreRunURL === 'string' &&
      new RegExp(contract.coreRunURLPattern).test(value.coreRunURL) &&
      value.coreRunURL.endsWith('/' + value.coreRunId)) {
      result.schemaVersion = 1;
      result.coreRunId = value.coreRunId;
      result.coreRunURL = value.coreRunURL;
    }
    if (Array.isArray(value.results)) result.results = resultsProjection(value.results);
    if (Array.isArray(value.reasons)) result.reasons = value.reasons.filter(reason =>
      typeof reason === 'string' && /^[A-Za-z0-9_-]+$/.test(reason));
    if (Array.isArray(value.cleanup))
      result.cleanup = projectPackageCleanup(value.cleanup);
    return result;
  }
  const result = Object.fromEntries(Object.entries(value).filter(([key]) =>
    contract.successFields.includes(key)));
  if (Array.isArray(value.results)) result.results = resultsProjection(value.results);
  if (Array.isArray(value.cleanup)) result.cleanup = projectPackageCleanup(value.cleanup);
  if (value.completion !== undefined)
    result.completion = projectRolloutResult(value.completion);
  if (value.continuation !== undefined) result.continuation =
    projectRolloutResult(value.continuation) ??
      { status: 'pending', code: contract.malformedCode, results: [] };
  return result;
}

export function readRolloutProcessResult(stdout, stderr, exitCode) {
  try {
    const result = projectRolloutResult(JSON.parse(String(stdout).trim() ||
      String(stderr).trim()));
    if (result && rolloutResultExit(result) === exitCode) return result;
  } catch { /* Unknown child output is not a completed result or admission denial. */ }
  return { status: 'pending', code: contract.malformedCode };
}
