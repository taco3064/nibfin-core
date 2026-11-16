export const providerPin = { repository: 'taco3064/nibfin-core',
  commit: 'a'.repeat(40), manifestHash: 'b'.repeat(64) };
export const providerIsolation = { kind: 'linux-rootful-docker-v1',
  agent: { image: 'sha256:' + 'c'.repeat(64) },
  hooks: { image: 'sha256:' + 'd'.repeat(64) } };

export function providerHost() {
  const runner = { repository: 'example/pool', repositoryId: 1, memberId: 5,
    runnerId: 42, runnerName: 'slot-1', workflowId: 50,
    workflowPath: '.github/workflows/shared-runner.yml', jobName: 'shared-stage' };
  return structuredClone({ schemaVersion: 1, kind: 'single-host-linux-v1',
    uid: 90, runnerUid: 91, memberId: 5, stateRoot: '/state',
    tokenFile: '/private/token', authFile: '/private/codex', model: 'gpt-6',
    installation: { directory: '/opt/nibfin/core', pin: providerPin },
    repository: { approval: { repositoryId: 1 }, runner, isolation: providerIsolation },
    sharedRunner: { runner, caller: { repository: 'example/pool', repositoryId: 1 },
      repositories: [1, 2], additionalRunner: { uid: 92, id: 43, name: 'slot-2',
        isolation: structuredClone(providerIsolation) } } });
}
