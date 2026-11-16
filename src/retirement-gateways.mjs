import { command } from './process.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { requireThat } from './identity.mjs';
import { runnerGatewayLabel } from './host-containers.mjs';
import { sharedSlotIsolation } from './shared-runner.mjs';

import { managedGatewayLabel as managedLabel } from './shared-gateway-setup.mjs';
const options = { env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent',
  DOCKER_CONFIG: '/nonexistent', LANG: 'C' }, limit: 65536 };
export const retirementGatewayEffects = [1, 2].flatMap(slot =>
  [`gateway-stop-${slot}`, `gateway-remove-${slot}`, `network-remove-${slot}`]);

export class RetirementGateways {
  constructor(run = command, inspect = rootOwnedPath) {
    this.run = run;
    this.inspect = inspect;
  }
  async docker(profile, args) {
    const c = profile.agent;
    await this.inspect(c.docker);
    const result = await this.run(c.docker,
      ['--host', `unix://${c.socket}`, ...args], options);
    return result.stdout.toString();
  }
  async object(profile, kind, id) {
    const rows = (await this.docker(profile, [kind, 'ls',
      ...(kind === 'container' ? ['--all'] : []), '--no-trunc',
      '--filter', `id=${id}`, '--format', '{{.ID}}']))
      .trim().split('\n').filter(Boolean);
    requireThat(rows.length === 0 || rows.length === 1 && rows[0] === id,
      'RETIREMENT_GATEWAY_UNKNOWN');
    if (!rows.length) return null;
    const result = JSON.parse(await this.docker(profile, [kind, 'inspect', id]));
    requireThat(result.length === 1 && result[0].Id === id,
      'RETIREMENT_GATEWAY_UNKNOWN');
    return result[0];
  }
  async bind(host) {
    const profiles = [host.runnerUid, host.sharedRunner.additionalRunner.uid]
      .map(uid => sharedSlotIsolation(host, uid));
    const bindings = [];
    for (const [index, profile] of profiles.entries()) {
      const c = profile.agent;
      requireThat(/^[a-f0-9]{64}$/.test(c.gatewayId),
        'RETIREMENT_GATEWAY_UNKNOWN');
      const gateway = await this.object(profile, 'container', c.gatewayId);
      requireThat(gateway && typeof gateway.NetworkSettings?.Networks?.[c.network]
        ?.NetworkID === 'string', 'RETIREMENT_GATEWAY_UNKNOWN');
      const networkId = gateway.NetworkSettings.Networks[c.network].NetworkID;
      requireThat(/^[a-f0-9]{64}$/.test(networkId), 'RETIREMENT_GATEWAY_UNKNOWN');
      const network = await this.object(profile, 'network', networkId);
      const runnerId = index === 0 ? host.sharedRunner.runner.runnerId :
        host.sharedRunner.additionalRunner.id;
      const label = runnerGatewayLabel({
        repositoryId: host.sharedRunner.runner.repositoryId, runnerId });
      const marker = gateway.Config?.Labels?.[managedLabel];
      requireThat(network?.Name === c.network && network.Driver === 'bridge' &&
        network.Internal === true && /^[a-f0-9]{64}$/.test(marker ?? '') &&
        network.Labels?.[managedLabel] === marker &&
        gateway.Config.Labels[label[0]] === label[1] &&
        Object.keys(network.Containers ?? {}).every(id => id === c.gatewayId),
      'RETIREMENT_GATEWAY_IDENTITY_CHANGED');
      bindings.push({ profile, gatewayId: c.gatewayId, networkId,
        network: c.network, label, marker });
    }
    requireThat(new Set(bindings.map(x => x.gatewayId)).size === 2 &&
      new Set(bindings.map(x => x.networkId)).size === 2,
    'RETIREMENT_LAYOUT_UNSUPPORTED');
    return bindings;
  }
  async observe(name, state) {
    requireThat(retirementGatewayEffects.includes(name), 'RETIREMENT_EFFECT_INVALID');
    const slot = Number(name.at(-1)), binding = state.gateways[slot - 1];
    const gateway = await this.object(binding.profile, 'container', binding.gatewayId);
    const network = await this.object(binding.profile, 'network', binding.networkId);
    if (gateway) requireThat(gateway.Config?.Labels?.[managedLabel] === binding.marker &&
      gateway.Config.Labels[binding.label[0]] === binding.label[1],
    'RETIREMENT_GATEWAY_IDENTITY_CHANGED');
    if (network) requireThat(network.Name === binding.network &&
      network.Labels?.[managedLabel] === binding.marker &&
      Object.keys(network.Containers ?? {}).every(id => id === binding.gatewayId),
    'RETIREMENT_GATEWAY_IDENTITY_CHANGED');
    if (name.startsWith('gateway-stop')) {
      if (!gateway) {
        requireThat(state.effects[`gateway-remove-${slot}`],
          'RETIREMENT_GATEWAY_UNKNOWN');
        return 'done';
      }
      if (gateway.State?.Running === false && gateway.State.Restarting === false &&
        gateway.State.Pid === 0) return 'done';
      requireThat(gateway.State?.Running === true, 'RETIREMENT_GATEWAY_UNKNOWN');
      return 'absent';
    }
    if (name.startsWith('gateway-remove')) {
      requireThat(state.effects[`gateway-stop-${slot}`] === 'done',
        'RETIREMENT_GATEWAY_UNKNOWN');
      return gateway ? 'absent' : 'done';
    }
    requireThat(!gateway && state.effects[`gateway-remove-${slot}`] === 'done',
      'RETIREMENT_GATEWAY_UNKNOWN');
    return network ? 'absent' : 'done';
  }
  async perform(name, state) {
    await this.observe(name, state);
    const binding = state.gateways[Number(name.at(-1)) - 1];
    const args = name.startsWith('gateway-stop')
      ? ['container', 'stop', '--time', '10', binding.gatewayId]
      : name.startsWith('gateway-remove')
        ? ['container', 'rm', binding.gatewayId]
        : ['network', 'rm', binding.networkId];
    await this.docker(binding.profile, args);
  }
}
