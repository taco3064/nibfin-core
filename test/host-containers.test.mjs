import assert from 'node:assert/strict';
import test from 'node:test';
import { idleContainers, issueContainerLabel } from '../src/host-containers.mjs';

const agent = { docker: '/usr/bin/docker', socket: '/run/nibfin/docker.sock',
  network: 'runner-a', gatewayId: 'a'.repeat(64) };
const profile = { agent, hooks: { docker: agent.docker, socket: agent.socket } };
const issue = { repositoryId: 10, number: 15 };

test('container preflight checks the current Issue and its network', async () => {
  const filters = [];
  const issueLabel = issueContainerLabel(issue).join('=');
  let ownHook = false, peerOnNetwork = false;
  const run = async (docker, args) => {
    assert.equal(docker, agent.docker);
    const filter = args[args.indexOf('--filter') + 1];
    filters.push(filter);
    const ids = filter === `label=${issueLabel}`
      ? ownHook ? 'b'.repeat(64) : ''
      : agent.gatewayId + (peerOnNetwork ? '\n' + 'c'.repeat(64) : '');
    return { stdout: Buffer.from(ids) };
  };
  assert.match(await idleContainers(profile, issue, run), /^[a-f0-9]{64}$/);
  assert.deepEqual(filters, ['network=runner-a', `label=${issueLabel}`]);
  ownHook = true;
  await assert.rejects(idleContainers(profile, issue, run),
    { code: 'PREVIOUS_HOST_PROCESS_UNRESOLVED' });
  ownHook = false;
  peerOnNetwork = true;
  await assert.rejects(idleContainers(profile, issue, run),
    { code: 'PREVIOUS_HOST_PROCESS_UNRESOLVED' });
});
