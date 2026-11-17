import { digest, requireThat } from './identity.mjs';

export const modelEntry = '/opt/nibfin/claude/model-entry.mjs';
export const fixedNode = '/usr/local/bin/node';
const profile = 'codex-security-container';
const security = ['no-new-privileges', `apparmor=${profile}`];
const configTmp = 'rw,nosuid,nodev,noexec,size=96m,mode=0700,uid=1001,gid=1001';
const scratchTmp = 'rw,nosuid,nodev,noexec,size=128m,mode=1777';
const user = '1001:1001';

export function modelEnvironment(plan, egress) {
  const { PATH, HOME, CLAUDE_CONFIG_DIR, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB } =
    plan.environment;
  return Object.entries({
    PATH, HOME, CLAUDE_CONFIG_DIR, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB,
    HTTPS_PROXY: egress.proxyUrl, HTTP_PROXY: egress.proxyUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }).map(([key, value]) => `${key}=${value}`);
}

export function modelContainerArgs({ image, name, plan, channel, egress, inherited }) {
  return ['create', '-i', '--pull=never', '--name', name, '--log-driver=none',
    '--read-only', `--network=${egress.network}`, '--dns=127.0.0.1', '--ipc=none',
    '--cap-drop=ALL', ...security.map(value => `--security-opt=${value}`),
    '--pids-limit=128', '--memory=2g', '--memory-swap=2g', '--cpus=1',
    `--user=${user}`, '--workdir=/session',
    `--tmpfs=/session/config:${configTmp}`, `--tmpfs=/tmp:${scratchTmp}`,
    '--mount', `type=bind,src=${channel},dst=/session/work-channel,` +
      'readonly,bind-propagation=rprivate,bind-recursive=disabled',
    ...inherited.flatMap(name => ['--env', name]),
    ...modelEnvironment(plan, egress).flatMap(value => ['--env', value]),
    '--entrypoint', fixedNode, image, modelEntry, ...plan.args];
}

export function inspectModelContainer(actual, { image, name, id, plan,
  channel, egress }) {
  const config = actual?.Config, host = actual?.HostConfig;
  const expected = modelEnvironment(plan, egress).sort();
  const [mount] = actual?.Mounts ?? [];
  requireThat(actual?.Id === id && actual.Name === `/${name}` &&
    actual.State?.Status === 'created' && config?.Image === image &&
    config.User === user && config.WorkingDir === '/session' &&
    config.OpenStdin === true && !config.Tty &&
    digest(config.Entrypoint) === digest([fixedNode]) &&
    digest(config.Cmd) === digest([modelEntry, ...plan.args]) &&
    digest([...config.Env].sort()) === digest(expected) &&
    !config.Healthcheck && !Object.keys(config.Volumes ?? {}).length &&
    actual.Mounts.length === 1 && mount?.Type === 'bind' &&
    mount.Source === channel && mount.Destination === '/session/work-channel' &&
    mount.RW === false && mount.Propagation === 'rprivate' &&
    host?.LogConfig?.Type === 'none' && host.Privileged === false &&
    host.ReadonlyRootfs === true && host.NetworkMode === egress.network &&
    Object.keys(actual.NetworkSettings?.Networks ?? {}).join() === egress.network &&
    digest(host.Dns) === digest(['127.0.0.1']) && host.IpcMode === 'none' &&
    !host.PidMode && !host.UsernsMode && !host.UTSMode && !host.Devices?.length &&
    !host.DeviceRequests?.length && !host.CapAdd?.length && !host.ExtraHosts?.length &&
    host.Memory === 2147483648 && host.MemorySwap === 2147483648 &&
    host.NanoCpus === 1000000000 && host.PidsLimit === 128 &&
    digest(host.CapDrop) === digest(['ALL']) &&
    digest([...host.SecurityOpt].sort()) === digest([...security].sort()) &&
    Object.keys(host.Tmpfs ?? {}).sort().join() === '/session/config,/tmp' &&
    host.Tmpfs['/session/config'] === configTmp && host.Tmpfs['/tmp'] === scratchTmp &&
    actual.AppArmorProfile === profile, 'CLAUDE_MODEL_ISOLATION_MISMATCH');
}
