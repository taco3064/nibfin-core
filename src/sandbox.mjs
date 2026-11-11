import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { command } from './process.mjs';
import { digest, requireThat } from './identity.mjs';
import {
  dockerBackend,
  validDockerEndpoint,
  verifyDockerSocket,
  dockerInfo,
} from './docker-backend.mjs';
import { verifyAppArmor } from './apparmor-proof.mjs';
import { shareAgentMount, cleanupAgentMounts } from './agent-mounts.mjs';
import { containerLabelArgs, matchesContainerLabel } from './host-containers.mjs';
export { rootlessInfo } from './docker-backend.mjs';

// Offline hooks use no Agent login, Docker socket or Core state mount. Agent
// network/authentication is a separate adapter; never relax this hook profile.
export class OfflineSandbox {
  #config;
  #run;
  #host;
  #backend;
  #containerLabel;
  constructor(
    config,
    {
      run = command,
      backend,
      containerLabel,
      host = { platform: process.platform, uid: process.getuid?.(), lstat, realpath },
    } = {},
  ) {
    this.#backend = dockerBackend(backend);
    requireThat(
      config &&
        Object.keys(config).sort().join(',') === 'docker,image,socket' &&
        /^(?:[A-Za-z0-9._:/-]+@)?sha256:[a-f0-9]{64}$/.test(config.image) &&
        validDockerEndpoint(config, this.#backend),
      'INVALID_SANDBOX_CONFIG',
    );
    this.#config = structuredClone(config);
    this.#run = run;
    this.#host = host;
    this.#containerLabel = containerLabel;
  }
  async #docker(args, options = {}) {
    return this.#run(
      this.#config.docker,
      ['--host', `unix://${this.#config.socket}`, ...args],
      {
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C.UTF-8',
          HOME: '/nonexistent',
          DOCKER_CONFIG: '/nonexistent',
        },
        ...options,
      },
    );
  }
  async preflight() {
    await verifyDockerSocket(this.#config.socket, this.#backend, this.#host);
    const info = JSON.parse(
      (await this.#docker(['info', '--format', '{{json .}}'])).stdout.toString(),
    );
    const observationHash = dockerInfo(info, this.#backend);
    const image = JSON.parse(
      (await this.#docker(['image', 'inspect', this.#config.image])).stdout.toString(),
    );
    requireThat(
      Array.isArray(image) &&
        image.length === 1 &&
        (image[0].Id === this.#config.image ||
          image[0].RepoDigests?.includes(this.#config.image)),
      'SANDBOX_IMAGE_UNAVAILABLE',
    );
    const namespaceProof =
      this.#backend.mode === 'rootful'
        ? await verifyAppArmor(
            (args, options) => this.#docker(args, options),
            this.#config.image,
            this.#backend.namespace,
          )
        : null;
    return {
      profile: this.#backend.kind,
      observationHash: digest({
        daemon: observationHash,
        image: image[0].Id,
        ...(namespaceProof ? { namespaceProof } : {}),
      }),
    };
  }
  async execute({ work, baseline, script, executionId = randomUUID() }) {
    requireThat(
      typeof script === 'string' && script && /^[a-f0-9-]{36}$/.test(executionId),
      'INVALID_SANDBOX_EXECUTION',
    );
    for (const path of [work, baseline]) {
      requireThat(
        typeof path === 'string' &&
          isAbsolute(path) &&
          !/[,\x00-\x1f]/.test(path) &&
          (await this.#host.realpath(path)) === resolve(path) &&
          (await this.#host.lstat(path)).isDirectory(),
        'UNSAFE_SANDBOX_MOUNT',
      );
    }
    requireThat(
      work !== baseline &&
        !work.startsWith(`${baseline}/`) &&
        !baseline.startsWith(`${work}/`),
      'OVERLAPPING_SANDBOX_MOUNTS',
    );
    const preflight = await this.preflight(),
      name = `nibfin-hooks-${randomUUID()}`;
    const rootful = this.#backend.mode === 'rootful';
    if (rootful) {
      await shareAgentMount(work, true);
      await shareAgentMount(baseline, false);
    }
    const args = [
      'create',
      '--pull=never',
      '--name',
      name,
      ...containerLabelArgs(this.#containerLabel),
      '--read-only',
      '--network',
      'none',
      '--ipc',
      'none',
      ...(rootful ? ['--security-opt=apparmor=codex-security-container'] : []),
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=128',
      '--memory=1g',
      '--cpus=1',
      '--user',
      '0:0',
      '--tmpfs',
      '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
      '--mount',
      `type=bind,src=${work},dst=/work,bind-propagation=rprivate,bind-recursive=disabled`,
      '--mount',
      `type=bind,src=${baseline},dst=/baseline-git,readonly,` +
        'bind-propagation=rprivate,bind-recursive=disabled',
      '--workdir',
      '/work',
      '--env',
      'HOME=/tmp',
      '--env',
      'GIT_CONFIG_NOSYSTEM=1',
      '--env',
      'GIT_CONFIG_GLOBAL=/dev/null',
      '--entrypoint',
      '/bin/sh',
      this.#config.image,
      '-c',
      script,
    ];
    let id,
      started = false,
      result,
      output;
    try {
      id = (await this.#docker(args)).stdout.toString().trim();
      requireThat(/^[a-f0-9]{64}$/.test(id), 'UNKNOWN_CREATED_CONTAINER');
      const observed = JSON.parse(
        (await this.#docker(['inspect', id])).stdout.toString(),
      );
      requireThat(
        Array.isArray(observed) && observed.length === 1,
        'AMBIGUOUS_CONTAINER',
      );
      const actual = observed[0],
        host = actual.HostConfig;
      requireThat(
        actual.Id === id &&
          actual.Name === `/${name}` &&
          actual.State?.Status === 'created' &&
          actual.Config?.Image === this.#config.image &&
          matchesContainerLabel(actual, this.#containerLabel) &&
          actual.Config.User === '0:0' &&
          digest(actual.Config.Entrypoint) === digest(['/bin/sh']) &&
          digest(actual.Config.Cmd) === digest(['-c', script]) &&
          host?.Privileged === false &&
          host.ReadonlyRootfs === true &&
          host.NetworkMode === 'none' &&
          host.IpcMode === 'none' &&
          !host.PidMode &&
          host.Memory === 1073741824 &&
          host.NanoCpus === 1000000000 &&
          host.PidsLimit === 128 &&
          digest(host.CapDrop) === digest(['ALL']) &&
          host.SecurityOpt?.includes('no-new-privileges') &&
          (!rootful ||
            (actual.AppArmorProfile === 'codex-security-container' &&
              !host.UsernsMode)) &&
          Array.isArray(actual.Mounts) &&
          actual.Mounts.length === 2 &&
          actual.Mounts.some(
            (m) =>
              m.Type === 'bind' &&
              m.Source === work &&
              m.Destination === '/work' &&
              m.RW === true,
          ) &&
          actual.Mounts.some(
            (m) =>
              m.Type === 'bind' &&
              m.Source === baseline &&
              m.Destination === '/baseline-git' &&
              m.RW === false,
          ),
        'CONTAINER_ISOLATION_MISMATCH',
      );
      started = true;
      output = await this.#docker(['start', '--attach', id], { timeout: 120000 });
      const after = JSON.parse(
        (await this.#docker(['inspect', id])).stdout.toString(),
      )[0];
      requireThat(
        after?.Id === id &&
          after.State?.Running === false &&
          after.State.ExitCode === 0 &&
          after.State.OOMKilled === false,
        'HOOK_CONTAINER_FAILED',
      );
      result = {
        status: 'passed',
        executionId,
        isolationHash: digest({ preflight, container: actual }),
        outputHash: digest({
          stdout: output.stdout.toString('base64'),
          stderr: output.stderr.toString('base64'),
        }),
      };
    } catch {
      result = {
        status: started ? 'failed' : 'denied',
        executionId,
        code: started ? 'HOOK_EXECUTION_FAILED' : 'SANDBOX_ENTRY_DENIED',
      };
    } finally {
      // Create can have taken effect even when its response was lost. The unique
      // trusted name is the reconciliation target; never launch another writer.
      try {
        const exists = (
          await this.#docker(['ps', '-aq', '--filter', `name=^/${name}$`])
        ).stdout
          .toString()
          .trim();
        if (exists) {
          requireThat(/^[a-f0-9]{12,64}$/.test(exists), 'AMBIGUOUS_CONTAINER_CLEANUP');
          await this.#docker(['rm', '--force', name]);
        }
        requireThat(
          !(await this.#docker(['ps', '-aq', '--filter', `name=^/${name}$`])).stdout
            .toString()
            .trim(),
          'CONTAINER_STILL_PRESENT',
        );
        if (rootful) {
          await this.#docker([
            'run',
            '--rm',
            '--network',
            'none',
            '--read-only',
            '--cap-drop=ALL',
            '--security-opt=no-new-privileges',
            '--user',
            '0:0',
            '--pids-limit=64',
            '--memory=128m',
            '--cpus=1',
            '--mount',
            `type=bind,src=${work},dst=/work,bind-recursive=disabled`,
            '--entrypoint',
            '/usr/local/bin/node',
            this.#config.image,
            '-e',
            cleanupAgentMounts,
            '/work',
          ]);
        }
      } catch {
        result = { status: 'pending', executionId, code: 'WRITER_TERMINATION_UNKNOWN' };
      }
    }
    return result;
  }
}
