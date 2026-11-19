import { digest, requireThat } from './identity.mjs';
import { projectToolPath } from './tool-catalog.mjs';
import { agentScratchMount, agentScratchOptions } from './agent-scratch.mjs';

export const workerEntry = '/opt/nibfin/work/claude-work-worker.py';
export const workerPython = '/usr/local/bin/python3';
export const workerEnvironment = Object.freeze([
  'HOME=/tmp', 'TMPDIR=/tmp', 'LANG=C.UTF-8', `PATH=${projectToolPath}`,
  'GIT_CONFIG_NOSYSTEM=1', 'GIT_CONFIG_GLOBAL=/dev/null',
]);

export function workContainerArgs(config, name, mounts, writable,
  inherited = [], egress) {
  return [
    'create', '--pull=never', '--name', name, '--read-only',
    `--network=${egress.network}`, '--dns=127.0.0.1',
    '--ipc=none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--security-opt=apparmor=codex-security-container', '--pids-limit=256',
    '--memory=4g', '--memory-swap=8g', '--cpus=2', '--user=1000:1000',
    `--tmpfs=${agentScratchMount}`, '--workdir=/work',
    ...mounts.flatMap(m => ['--mount', `type=bind,src=${m.source},` +
      `dst=${m.target},${m.target === '/work' && writable ||
        m.target === '/session/work-channel' ? '' : 'readonly,'}` +
      'bind-propagation=rprivate,bind-recursive=disabled']),
    ...inherited.flatMap(name => ['--env', name]),
    ...workEnvironment(egress).flatMap(value => ['--env', value]),
    '--entrypoint', workerPython, config.image, '-I', '-B', workerEntry,
  ];
}

// Inspect exact effective configuration, including inherited image settings.
// Merely requesting flags is insufficient evidence of applied isolation.
export function inspectWorkContainer(actual, {
  config, name, id, mounts, writable, egress,
}) {
  const h = actual?.HostConfig, c = actual?.Config;
  const expected = new Set(workEnvironment(egress));
  requireThat(actual?.Id === id && actual.Name === `/${name}` &&
    actual.State?.Status === 'created' && c?.Image === config.image &&
    c.User === '1000:1000' && c.WorkingDir === '/work' &&
    digest(c.Entrypoint) === digest([workerPython]) &&
    digest(c.Cmd) === digest(['-I', '-B', workerEntry]) &&
    Array.isArray(c.Env) && c.Env.length === expected.size &&
    c.Env.every(value => expected.has(value)) &&
    !c.Healthcheck && !(c.Volumes && Object.keys(c.Volumes).length) &&
    h?.Privileged === false && h.ReadonlyRootfs === true &&
    h.NetworkMode === egress.network &&
    digest(h.Dns) === digest(['127.0.0.1']) &&
    Object.keys(actual.NetworkSettings?.Networks ?? {}).join() === egress.network &&
    h.IpcMode === 'none' &&
    !h.PidMode && !h.UsernsMode && !h.UTSMode && !h.Devices?.length &&
    !h.DeviceRequests?.length && !h.CapAdd?.length && !h.ExtraHosts?.length &&
    h.Memory === 4294967296 && h.MemorySwap === 8589934592 &&
    h.NanoCpus === 2000000000 && h.PidsLimit === 256 &&
    digest(h.CapDrop) === digest(['ALL']) &&
    Array.isArray(h.SecurityOpt) &&
    digest([...h.SecurityOpt].sort()) === digest([
      'apparmor=codex-security-container', 'no-new-privileges',
    ]) &&
    actual.AppArmorProfile === 'codex-security-container' &&
    h.Tmpfs && Object.keys(h.Tmpfs).join() === '/tmp' &&
    h.Tmpfs['/tmp'] === agentScratchOptions &&
    Array.isArray(actual.Mounts) && actual.Mounts.length === mounts.length &&
    mounts.every(m => actual.Mounts.some(a => a.Type === 'bind' &&
      a.Source === m.source && a.Destination === m.target &&
      a.RW === (m.target === '/session/work-channel' ||
        m.target === '/work' && writable) && a.Propagation === 'rprivate')),
  'CLAUDE_WORK_ISOLATION_MISMATCH');

}

export function workEnvironment(egress) {
  return [...workerEnvironment, ...['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']
    .map(key => `${key}=${egress.proxyUrl}`), 'NODE_USE_ENV_PROXY=1'];
}
