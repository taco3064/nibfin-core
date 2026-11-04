import { isDigest, requireThat } from './identity.mjs';

// Installed Core owns this finite list. A profile name is not isolation proof.
// Desktop backends remain unsupported until their implementation and actual
// positive/negative isolation checks exist; no request may register an adapter.
const profiles = Object.freeze({
  'linux-rootless-docker-v1': Object.freeze({
    hostPlatform: 'linux',
    runnerOS: 'linux',
    containerOS: 'linux',
    dockerMode: 'rootless',
  }),
  'linux-rootful-docker-v1': Object.freeze({
    hostPlatform: 'linux',
    runnerOS: 'linux',
    containerOS: 'linux',
    dockerMode: 'rootful',
  }),
});

export function executionProfile(name) {
  requireThat(
    typeof name === 'string' && Object.hasOwn(profiles, name),
    'UNVERIFIED_EXECUTION_BACKEND',
  );
  return profiles[name];
}

// The native observer supplies both facts. Neither labels nor an Agent result
// can turn a Windows Runner into the existing Linux host implementation.
export function requireExecutionIsolation(isolation, runner, execution) {
  const profile = executionProfile(isolation?.profile);
  requireThat(
    runner?.os === profile.runnerOS &&
      isDigest(isolation.observationHash) &&
      isolation.executionId === execution.id &&
      isolation.writerStatus === 'exclusive',
    'ISOLATION_OR_WRITER_PROOF_REQUIRED',
  );
}
