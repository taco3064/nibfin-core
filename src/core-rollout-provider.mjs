import { GitHubReader, repoPath } from './github-read.mjs';
import { command } from './process.mjs';
import { isId, isSha, requireThat } from './identity.mjs';

const fields = 'number,headRefOid,isDraft,mergeStateStatus,' +
  'isCrossRepository,files,statusCheckRollup';
const invalid = 'INVALID_ROLLOUT_PROVIDER_REQUEST';

function repository(value) {
  try { repoPath(value); return true; } catch { return false; }
}

function apiRoute(value) {
  if (typeof value !== 'string' || /[\0\\\r\n#]/.test(value)) return null;
  const path = value.startsWith('/') ? value : '/' + value;
  const match = /^\/repos\/([^/]+\/[^/?]+)(\/[^?]*)?(\?.*)?$/.exec(path);
  if (!match || !repository(match[1]) || path.split('?')[0].split('/')
    .some(part => part === '.' || part === '..')) return null;
  return { path, tail: match[2] ?? '', query: match[3] ?? '' };
}

export function rolloutProviderRoute(request) {
  requireThat(Array.isArray(request) && request.every(value =>
    typeof value === 'string' && !value.includes('\0')), invalid);
  if (request[0] === 'api') {
    const route = apiRoute(request[1]);
    requireThat(route, invalid);
    if (request.length === 2) return {
      kind: /^\/actions\/artifacts\/[1-9]\d*\/zip$/.test(route.tail) && !route.query ?
        'binary' : 'json', path: route.path,
    };
    const pull = /^\/pulls\/[1-9]\d*$/.test(route.tail);
    const refresh = /^\/pulls\/[1-9]\d*\/update-branch$/.test(route.tail);
    const field = request[5];
    requireThat(request.length === 6 && !route.query && request[2] === '--method' &&
      request[4] === '-f' && (request[3] === 'PATCH' && pull &&
        field === 'state=closed' ||
        request[3] === 'PUT' && refresh && field.startsWith('expected_head_sha=') &&
        isSha(field.slice('expected_head_sha='.length))), invalid);
    return { kind: 'write' };
  }
  requireThat(request[0] === 'pr' && request[2] === '-R' && repository(request[3]),
    invalid);
  if (request[1] === 'list') {
    requireThat(request.length === 10 && request[4] === '--base' &&
      request[5] === 'main' && request[6] === '--head' &&
      /^cd\/consumers-[a-f0-9]{12}-[a-f0-9]{12}$/.test(request[7]) &&
      request[8] === '--json' && request[9] === fields, invalid);
    return { kind: 'list' };
  }
  requireThat(request[1] === 'merge' && request.length === 8 &&
    /^[1-9]\d*$/.test(request[4]) && isId(Number(request[4])) &&
    request[5] === '--rebase' && request[6] === '--match-head-commit' &&
    isSha(request[7]), invalid);
  return { kind: 'write' };
}

// Fixed manager entry owns admission/credentials. These ports only make the
// maintained provider boundary testable; requests cannot select a local program.
export async function coreRolloutProvider(request, token, {
  reader = new GitHubReader(token), run = command,
} = {}) {
  const route = rolloutProviderRoute(request);
  let bytes;
  if (route.kind === 'json') {
    bytes = Buffer.from(JSON.stringify(await reader.get(route.path)));
  } else {
    const result = await run('/usr/bin/gh', request, {
      env: { PATH: '/usr/bin:/bin', LANG: 'C', GH_PROMPT_DISABLED: '1', GH_TOKEN: token },
    });
    bytes = result.stdout;
    if (route.kind === 'list') {
      let value;
      try { value = JSON.parse(bytes); } catch { /* CLI output has no HTTP type. */ }
      requireThat(Array.isArray(value), 'ROLLOUT_PROVIDER_RESPONSE_UNAVAILABLE');
    }
  }
  return { status: 'observed', bytes: bytes.toString('base64') };
}
