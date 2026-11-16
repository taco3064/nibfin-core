import { realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { command } from './process.mjs';
import { digest, requireThat } from './identity.mjs';
import { dockerBackend, dockerInfo, rootfulSocket } from './docker-backend.mjs';
import { coreRoot } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { containerLabelArgs, runnerGatewayLabel } from './host-containers.mjs';
import { CodexSandbox } from './codex-sandbox.mjs';
import { mcpPolicyEnvironment, mcpPolicyMount } from './mcp-egress.mjs';

const dockerPath = '/usr/bin/docker';
const settings = {
  env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent',
    LANG: 'C' },
};
const isolatedOption = 'com.docker.network.bridge.gateway_mode_ipv4';
export const managedGatewayLabel = 'io.nibfin.gateway-install';

const docker = async args => (await command(dockerPath, [
  '--host', `unix://${rootfulSocket}`, ...args,
], settings)).stdout.toString();

async function find(docker, kind, name) {
  const network = kind === 'network';
  const rows = await docker([kind, 'ls', ...(network ? [] : ['--all']),
    '--no-trunc', '--filter', `name=${name}`, '--format', '{{json .}}']);
  const matches = rows.trim().split('\n').filter(Boolean).map(row => JSON.parse(row))
    .filter(row => (network ? row.Name : row.Names) === name);
  requireThat(matches.length <= 1, 'SHARED_GATEWAY_RESOURCE_AMBIGUOUS');
  if (!matches.length) return null;
  const result = JSON.parse(await docker([kind, 'inspect', matches[0].ID]));
  requireThat(result.length === 1, 'SHARED_GATEWAY_RESOURCE_AMBIGUOUS');
  return result[0];
}

async function ensure(docker, kind, name, create) {
  const observed = await find(docker, kind, name);
  if (observed) return observed;
  // Even a lost reply can follow a successful write. Reconcile the exact name
  // before proceeding, and leave other resources untouched.
  await docker(create).catch(() => {});
  const created = await find(docker, kind, name);
  requireThat(created, 'SHARED_GATEWAY_SETUP_READBACK_REQUIRED');
  return created;
}

export async function prepareSharedGateway(profile, runner, uplink, run = docker) {
  const label = runnerGatewayLabel(runner);
  const name = `nibfin-gateway-${label[1]}`;
  const proxyScript = join(coreRoot, 'src/egress-proxy.mjs');
  const { image, mcpPolicyDirectory } = profile.agent;
  const marker = digest({
    binding: label[1], image, uplink, mcp: mcpPolicyDirectory ?? null,
  });
  requireThat(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(uplink) &&
    !['bridge', 'host', 'none', 'default', name].includes(uplink) &&
    (!mcpPolicyDirectory || /^\/[A-Za-z0-9._/-]+$/.test(mcpPolicyDirectory)),
  'SHARED_GATEWAY_SETUP_INVALID');
  if (mcpPolicyDirectory)
    requireThat(await realpath(mcpPolicyDirectory) === mcpPolicyDirectory,
      'SHARED_GATEWAY_SETUP_INVALID');
  const external = await find(run, 'network', uplink);
  requireThat(external?.Driver === 'bridge' && external.Internal === false,
    'SHARED_GATEWAY_UPLINK_UNVERIFIED');
  const network = await ensure(run, 'network', name, ['network', 'create',
    '--driver', 'bridge', '--internal', '--opt', `${isolatedOption}=isolated`,
    '--label', `${managedGatewayLabel}=${marker}`, name]);
  requireThat(network.Name === name && network.Internal === true &&
    network.Driver === 'bridge' && network.Options?.[isolatedOption] === 'isolated' &&
    network.Labels?.[managedGatewayLabel] === marker, 'SHARED_GATEWAY_NETWORK_CONFLICT');
  const mcp = mcpPolicyDirectory ? [
    '--env', `${mcpPolicyEnvironment}=${mcpPolicyMount}`, '--mount',
    `type=bind,src=${mcpPolicyDirectory},dst=${mcpPolicyMount},readonly`,
  ] : [];
  const gateway = await ensure(run, 'container', name, ['run', '--detach',
    '--pull=never', '--name', name, '--network', name, '--network', uplink,
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    ...containerLabelArgs(label), '--label', `${managedGatewayLabel}=${marker}`,
    '--mount', `type=bind,src=${proxyScript},dst=/proxy.mjs,readonly`, ...mcp,
    '--entrypoint', 'node', image, '/proxy.mjs']);
  const attached = gateway.NetworkSettings?.Networks ?? {};
  requireThat(gateway.Name === `/${name}` && gateway.State?.Running === true &&
    gateway.Config?.Labels?.[managedGatewayLabel] === marker &&
    gateway.Config.Labels[label[0]] === label[1] &&
    /^[a-f0-9]{64}$/.test(gateway.Id) &&
    Object.keys(attached).length === 2 && attached[name]?.NetworkID === network.Id &&
    attached[uplink]?.NetworkID === external.Id, 'SHARED_GATEWAY_CONTAINER_CONFLICT');
  return { ...profile, agent: { ...profile.agent, gatewayId: gateway.Id,
    network: name, proxyScript } };
}

export async function prepareSharedGateways(profiles, runner, second, uplink) {
  for (const path of [dockerPath, process.execPath, '/usr/sbin/runuser'])
    await rootOwnedPath(path);
  const result = [];
  const info = JSON.parse(await docker(['info', '--format', '{{json .}}']));
  for (const [index, id] of [runner.runnerId, second.runnerId].entries()) {
    dockerInfo(info, dockerBackend(profiles[index]));
    const slot = { repositoryId: runner.repositoryId, runnerId: id };
    const profile = await prepareSharedGateway(profiles[index], slot, uplink);
    const script = fileURLToPath(import.meta.url);
    await command('/usr/sbin/runuser', [
      '-u', 'nibfin-controller', '--', process.execPath, script,
    ], { ...settings, input: JSON.stringify({ profile, slot }) });
    result.push(profile);
  }
  return result;
}

// Only the administrator's installer calls this controller-side read-back.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = '';
    for await (const chunk of process.stdin.setEncoding('utf8')) {
      input += chunk;
      requireThat(Buffer.byteLength(input) <= 32768, 'SHARED_GATEWAY_SETUP_INVALID');
    }
    const { profile, slot } = JSON.parse(input);
    const backend = dockerBackend(profile);
    await new CodexSandbox({ ...profile.agent, coreRoot },
      { backend, gatewayLabel: runnerGatewayLabel(slot) }).preflight();
  } catch {
    process.exitCode = 1;
  }
}
