import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { digest, sha256, requireThat } from './identity.mjs';
import { sameContainerEnvironment } from './container-environment.mjs';

// The composing runner creates a private isolated network and package gateway.
// No provider/MCP policy mount or authentication destination is admitted here.
export async function verifyWorkEgress(config, docker, model = false) {
  const profile = model ? 'model' : 'work';
  const proxy = model ? 'claude-model-proxy.mjs' : 'claude-package-proxy.mjs';
  requireThat(config && /^[a-f0-9]{64}$/.test(config.gatewayId) &&
    /^sha256:[a-f0-9]{64}$/.test(config.image) &&
    new RegExp(`^nibfin-${profile}-[a-f0-9-]{36}$`).test(config.network),
  'INVALID_WORK_EGRESS');
  const inspect = async args => {
    const result = JSON.parse((await docker(args)).stdout);
    requireThat(Array.isArray(result) && result.length === 1,
      'AMBIGUOUS_WORK_EGRESS');
    return result[0];
  };
  const network = await inspect(['network', 'inspect', config.network]);
  const gateway = await inspect(['inspect', config.gatewayId]);
  const image = await inspect(['image', 'inspect', config.image]);
  const sources = ['egress-proxy.mjs', proxy];
  for (const name of sources) {
    const path = join(config.directory, name);
    const maintained = new URL(name, import.meta.url);
    requireThat(await realpath(path) === resolve(path) &&
      sha256(await readFile(path)) === sha256(await readFile(maintained)),
    'WORK_EGRESS_SOURCE_CHANGED');
  }
  const c = gateway.Config, h = gateway.HostConfig;
  const ip = gateway.NetworkSettings?.Networks?.[config.network]?.IPAddress;
  requireThat(image.Id === config.image && gateway.Id === config.gatewayId &&
    gateway.State?.Running === true && c?.Image === config.image &&
    sameContainerEnvironment(c.Env, image.Config?.Env ?? []) &&
    digest(c.Entrypoint) === digest(['node']) &&
    digest(c.Cmd) === digest([`/proxy/${proxy}`]) &&
    h?.Privileged === false && h.ReadonlyRootfs === true &&
    !h.PidMode && !h.UsernsMode && !h.CapAdd?.length && !h.Devices?.length &&
    digest(h.CapDrop) === digest(['ALL']) &&
    digest(h.SecurityOpt) === digest(['no-new-privileges']) &&
    gateway.Mounts?.length === sources.length &&
    sources.every(name => gateway.Mounts.some(m => m.Type === 'bind' &&
      m.Source === join(config.directory, name) &&
      m.Destination === `/proxy/${name}` && m.RW === false)) &&
    network.Name === config.network && network.Driver === 'bridge' &&
    network.Internal === true &&
    network.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] === 'isolated' &&
    Object.keys(network.Containers ?? {}).join() === config.gatewayId &&
    /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip),
  'WORK_EGRESS_NOT_ISOLATED');
  return { network: config.network, proxyUrl: `http://${ip}:3128`,
    observationHash: digest({ network, gateway, image: image.Id }) };
}
