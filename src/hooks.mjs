import { digest, isSha, requireThat } from './identity.mjs';
import { safeCandidatePath } from './candidate-contract.mjs';

// The generated script runs only inside OfflineSandbox. Every interpolated
// value is a validated Git identity/path or a base64-encoded data value.
export function hookScript(candidate, phase, message) {
  requireThat(['pre-accept', 'post-accept'].includes(phase) && isSha(candidate?.base) && isSha(candidate.tree) &&
    Array.isArray(candidate.paths) && candidate.paths.every(safeCandidatePath) &&
    Array.isArray(candidate.obligations?.hooks) && typeof message === 'string', 'INVALID_HOOK_INPUT');
  const hooks = candidate.obligations.hooks.filter(h => phase === 'pre-accept' ? h.event === 'pre-commit' : h.event !== 'pre-commit');
  requireThat(hooks.every(h => safeCandidatePath(h.path) && ['pre-commit', 'prepare-commit-msg', 'commit-msg'].includes(h.event)), 'UNSUPPORTED_HOOK');
  const paths = Buffer.from(candidate.paths.map(path => `${path}\0`).join('')).toString('base64');
  const text = Buffer.from(message).toString('base64');
  return { hooks, script: `set -eu
umask 077
cp -R /baseline-git /tmp/hooks.git
export GIT_DIR=/tmp/hooks.git GIT_WORK_TREE=/work
export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null GIT_CONFIG_KEY_1=core.autocrlf GIT_CONFIG_VALUE_1=false
git read-tree ${candidate.tree}
printf '%s' '${text}' | base64 -d >/tmp/message
cp /tmp/message /tmp/original-message
printf '%s' '${paths}' | base64 -d >/tmp/expected-paths
git diff --cached --name-only -z ${candidate.base} -- >/tmp/actual-paths
cmp /tmp/expected-paths /tmp/actual-paths
${hooks.map(h => `sh /work/${h.path}${h.event === 'pre-commit' ? '' : h.event === 'commit-msg' ? ' /tmp/message' : ' /tmp/message message'}`).join('\n')}
[ "$(git write-tree)" = '${candidate.tree}' ]
cmp /tmp/original-message /tmp/message
` };
}

export async function runCandidateHooks({ sandbox, workspace, candidate, shapeBody, phase, baseline, message, executionId }) {
  requireThat(digest(await workspace.capture(shapeBody)) === digest(candidate), 'CANDIDATE_CHANGED_BEFORE_HOOKS');
  const { hooks, script } = hookScript(candidate, phase, message);
  if (!hooks.length) return { status: 'passed', phase, candidateHash: digest(candidate), hookCount: 0, notApplicable: true };
  const result = await sandbox.execute({ work: workspace.work, baseline, script, executionId });
  if (result.status !== 'passed') return result;
  requireThat(digest(await workspace.capture(shapeBody)) === digest(candidate), 'HOOK_CHANGED_CANDIDATE');
  return { ...result, phase, candidateHash: digest(candidate), hookCount: hooks.length, messageHash: digest(message) };
}
