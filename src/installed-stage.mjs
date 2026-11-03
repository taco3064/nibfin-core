import { nativeStageExecutor, validStageRequest } from './native-stage.mjs';
import { actionsCaller } from './actions-identity.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { GitHubReader } from './github-read.mjs';
import { digest, requireThat } from './identity.mjs';

// Installation and caller pins come from trusted host adoption. Never read
// these from the stage request, an Issue, a Candidate or a dynamic module path.
// Source and caller verification are fixed here, not replaceable callbacks.
export async function installedStageExecutor({ installation, caller, config, execution,
  agent, workspace, sandbox, inspectIsolation, token, fetcher = fetch, clock = Date.now }) {
  const installed = structuredClone(installation), pinned = structuredClone(config);
  const identity = structuredClone(execution), oidc = structuredClone(caller);
  requireThat(installed && typeof installed.directory === 'string' && installed.pin &&
    oidc?.pin?.repository === pinned.runner?.repository &&
    oidc.pin.repositoryId === pinned.runner.repositoryId &&
    oidc.pin.workflowRef === `${pinned.runner.repository}/${pinned.runner.workflowPath}@${oidc.pin.ref}` &&
    digest(oidc.pin.reusable ?? null) === digest(pinned.runner.reusable ? {
      commit: pinned.runner.reusable.commit, ref: pinned.runner.reusable.ref,
    } : null), 'INSTALLATION_CALLER_BINDING_MISMATCH');
  const inspectSource = async () => {
    const source = await verifyInstalledSource(installed.directory, installed.pin);
    requireThat(digest(source) === digest(pinned.approval.source), 'ADOPTED_SOURCE_MISMATCH');
    return source;
  };
  // Reject a modified/mismatched installation before requesting credentials
  // from the Actions token service or observing any external repository state.
  await inspectSource();
  const inspectCaller = actionsCaller({ ...oidc, executionId: identity.id, fetcher, clock });
  const executor = nativeStageExecutor({ reader: new GitHubReader(token, fetcher), config: pinned,
    execution: identity, inspectIsolation, inspectSource, inspectCaller,
    agent, workspace, sandbox, token, fetcher, clock });
  return Object.freeze({
    async run(request) {
      if (!validStageRequest(request)) return { schemaVersion: 1, status: 'denied', code: 'INVALID_STAGE_REQUEST' };
      // Recheck before each invocation as well as every native observation.
      // A once-valid installation cannot retain authority after modification.
      try { await inspectSource(); }
      catch { return { schemaVersion: 1, stage: request.stage, status: 'denied', code: 'INSTALLED_SOURCE_CHANGED' }; }
      try { return await executor.run(request); }
      catch { return { schemaVersion: 1, stage: request.stage, status: 'pending', code: 'TRUSTED_STATE_UNAVAILABLE' }; }
    },
  });
}
