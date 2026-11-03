import { CodexSandbox } from './codex-sandbox.mjs';
import { OfflineSandbox } from './sandbox.mjs';
import { executionProfile } from './execution-profiles.mjs';
import { requireThat } from './identity.mjs';

// Fixed installed composition, never an adapter module or command from JSON.
// POSIX storage, host adoption and process controls remain backend restrictions.
export function codexEnvironment(profile, coreRoot) {
  const selected = executionProfile(profile?.kind);
  requireThat(
    process.platform === selected.hostPlatform,
    'UNSUPPORTED_EXECUTION_HOST',
  );
  requireThat(
    profile.agent?.docker === profile.hooks?.docker &&
      profile.agent?.socket === profile.hooks?.socket,
    'SPLIT_HOST_DAEMON',
  );
  return Object.freeze({
    agent: new CodexSandbox({ ...profile.agent, coreRoot }),
    hooks: new OfflineSandbox(profile.hooks),
  });
}
