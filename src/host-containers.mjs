import { command } from './process.mjs';
import { digest, isId, requireThat } from './identity.mjs';

const label = 'io.nibfin.issue';

export function runnerGatewayLabel(runner) {
  requireThat(isId(runner?.repositoryId) && isId(runner.runnerId),
    'INVALID_CONTAINER_RUNNER');
  return ['io.nibfin.runner', `${runner.repositoryId}-${runner.runnerId}`];
}

export function issueContainerLabel(issue) {
  requireThat(isId(issue?.repositoryId) && isId(issue.number),
    'INVALID_CONTAINER_ISSUE');
  return [label, `${issue.repositoryId}-${issue.number}`];
}

export function containerLabelArgs(expected) {
  return expected ? ['--label', expected.join('=')] : [];
}

export function matchesContainerLabel(container, expected) {
  return !expected || container.Config?.Labels?.[expected[0]] === expected[1];
}

export async function idleContainers(profile, issue, run = command) {
  const c = profile.agent;
  requireThat(c.docker === profile.hooks.docker && c.socket === profile.hooks.socket,
    'SPLIT_HOST_DAEMON');
  const list = async filter => {
    const result = await run(c.docker, [
      '--host', `unix://${c.socket}`, 'ps', '--all', '--no-trunc',
      '--filter', filter, '--format', '{{.ID}}',
    ], {
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent' },
      limit: 65536,
    });
    return result.stdout.toString().trim().split('\n').filter(Boolean);
  };
  const target = issue ? issueContainerLabel(issue).join('=') : label;
  const [network, containers] = await Promise.all([
    list(`network=${c.network}`),
    list(`label=${target}`),
  ]);
  requireThat(network.length === 1 && network[0] === c.gatewayId &&
    containers.length === 0, 'PREVIOUS_HOST_PROCESS_UNRESOLVED');
  return digest({ network, containers });
}
