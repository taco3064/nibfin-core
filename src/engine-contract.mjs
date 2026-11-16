import { rootfulSocket, dockerBackend } from './docker-backend.mjs';

export const engine = Object.freeze({
  socket: rootfulSocket,
  group: 'nibfin-engine',
  remap: 'nibfin-remap',
  controller: 'nibfin-controller',
  runners: ['nibfin-runner-1', 'nibfin-runner-2'],
  unit: 'nibfin-engine.service',
  unitPath: '/etc/systemd/system/nibfin-engine.service',
  config: '/etc/nibfin/engine/daemon.json',
  state: '/var/lib/nibfin-engine-install',
  data: '/var/lib/nibfin-engine',
  exec: '/run/nibfin-engine-exec',
  runtime: '/run/nibfin-engine',
  daemon: '/usr/bin/dockerd',
  plan: '/etc/nibfin/engine-install.json',
});

export function engineConfiguration() {
  return JSON.stringify({
    hosts: [`unix://${engine.socket}`],
    group: engine.group,
    'data-root': engine.data,
    'exec-root': engine.exec,
    pidfile: `${engine.exec}/docker.pid`,
    'userns-remap': `${engine.remap}:${engine.remap}`,
    'live-restore': false,
    'exec-opts': ['native.cgroupdriver=systemd'],
  }, null, 2) + '\n';
}

export function engineUnit() {
  return [
    '[Unit]',
    'Description=Nibfin dedicated Docker Engine',
    'After=network-online.target',
    'Wants=network-online.target',
    'Conflicts=docker.service docker.socket',
    '[Service]',
    'Type=notify',
    `ExecStart=${engine.daemon} --config-file=${engine.config}`,
    `Group=${engine.group}`,
    'ExecStartPre=/usr/bin/chmod 0710 /run/nibfin-engine',
    'Delegate=yes',
    'KillMode=process',
    'Restart=no',
    'TimeoutStartSec=90',
    'RuntimeDirectory=nibfin-engine nibfin-engine-exec',
    'RuntimeDirectoryMode=0700',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

export const engineBackend = namespace => dockerBackend({
  kind: 'linux-rootful-docker-v1', namespace,
});
