import {
  readFile,
  writeFile,
  lstat,
  realpath,
  open,
  mkdtemp,
  copyFile,
  rm,
  chmod,
  readdir,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { command, deliveryRoleTimeout } from './process.mjs';
import { codexIdle, codexPreflightExits, idleDiagnostic } from './codex-bootstrap.mjs';
import {
  shareAgentMount,
  privateMountParent,
  cleanupAgentMounts,
} from './agent-mounts.mjs';
import {
  dockerBackend,
  validDockerEndpoint,
  verifyDockerSocket,
  dockerInfo,
} from './docker-backend.mjs';
import { verifyAppArmor } from './apparmor-proof.mjs';
import { digest, sha256, requireThat } from './identity.mjs';
import { privateMcpToml } from './mcp-profile.mjs';
import { sameContainerEnvironment } from './container-environment.mjs';
import {
  acquireMcpEgress, verifyMcpPolicyDirectory,
  mcpPolicyEnvironment, mcpPolicyMount,
} from './mcp-egress.mjs';

async function privateJSON(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    requireThat(
      stat.isFile() && stat.nlink === 1 && stat.size <= limit,
      'UNSAFE_AGENT_OUTPUT',
    );
    const bytes = await file.readFile();
    requireThat(bytes.length <= limit, 'OVERSIZED_AGENT_OUTPUT');
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    await file.close();
  }
}

// One capability-gated adapter, not a product-wide OS prerequisite. A host that
// cannot enforce the nested Codex profile must fail the probe; never use --yolo,
// privileged containers, host networking or an unconfined seccomp fallback.
export class CodexSandbox {
  #config;
  #run;
  #host;
  #backend;
  constructor(
    config,
    {
      run = command,
      backend,
      host = { platform: process.platform, uid: process.getuid?.(), lstat, realpath },
    } = {},
  ) {
    this.#backend = dockerBackend(backend);
    requireThat(
      config &&
        /^(?:[A-Za-z0-9._:/-]+@)?sha256:[a-f0-9]{64}$/.test(config.image) &&
        validDockerEndpoint(config, this.#backend) &&
        /^[a-f0-9]{64}$/.test(config.gatewayId) &&
        /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(config.network) &&
        !['host', 'bridge', 'none', 'default'].includes(config.network) &&
        /^codex-cli \d+\.\d+\.\d+$/.test(config.codexVersion) &&
        isAbsolute(config.coreRoot) &&
        isAbsolute(config.proxyScript),
      'INVALID_CODEX_SANDBOX',
    );
    this.#config = structuredClone(config);
    this.#run = run;
    this.#host = host;
  }
  #docker(args, options = {}) {
    return this.#run(
      this.#config.docker,
      ['--host', `unix://${this.#config.socket}`, ...args],
      {
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/nonexistent',
          DOCKER_CONFIG: '/nonexistent',
          LANG: 'C.UTF-8',
        },
        ...options,
      },
    );
  }
  async #inspect(args) {
    return JSON.parse((await this.#docker(args)).stdout.toString());
  }
  async preflight() {
    const c = this.#config;
    await verifyDockerSocket(c.socket, this.#backend, this.#host);
    const daemon = dockerInfo(
      await this.#inspect(['info', '--format', '{{json .}}']),
      this.#backend,
    );
    const images = await this.#inspect(['image', 'inspect', c.image]).catch(error => {
      if (error.code !== 'PROCESS_FAILED') throw error;
      requireThat(false, 'AGENT_IMAGE_UNAVAILABLE');
    });
    requireThat(
      images.length === 1 &&
        (images[0].Id === c.image || images[0].RepoDigests?.includes(c.image)),
      'AGENT_IMAGE_UNAVAILABLE',
    );
    const apparmor = await verifyAppArmor(
      (args, options) => this.#docker(args, options),
      c.image,
      this.#backend.namespace,
    );
    const networks = await this.#inspect(['network', 'inspect', c.network]),
      gateways = await this.#inspect(['inspect', c.gatewayId]);
    requireThat(networks.length === 1 && gateways.length === 1,
      'AMBIGUOUS_AGENT_EGRESS');
    const network = networks[0],
      gateway = gateways[0],
      ip = gateway.NetworkSettings?.Networks?.[c.network]?.IPAddress;
    const source = await readFile(join(c.coreRoot, 'src/egress-proxy.mjs'));
    const extraMounts = c.mcpPolicyDirectory ? [{
      Source: c.mcpPolicyDirectory, Destination: mcpPolicyMount,
    }] : [];
    if (c.mcpPolicyDirectory) await verifyMcpPolicyDirectory(c.mcpPolicyDirectory);
    const gatewayEnvironment = [...(images[0].Config?.Env ?? []),
      ...(c.mcpPolicyDirectory ?
        [`${mcpPolicyEnvironment}=${mcpPolicyMount}`] : [])];
    requireThat(
      (await realpath(c.proxyScript)) === resolve(c.proxyScript) &&
        sha256(await readFile(c.proxyScript)) === sha256(source),
      'EGRESS_SOURCE_CHANGED',
    );
    requireThat(
      network.Name === c.network &&
        network.Driver === 'bridge' &&
        network.Internal === true &&
        network.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] ===
          'isolated' &&
        gateway.Id === c.gatewayId &&
        gateway.State?.Running === true &&
        gateway.Config?.Image === c.image &&
        gateway.HostConfig?.Privileged === false &&
        gateway.HostConfig.ReadonlyRootfs === true &&
        !gateway.HostConfig.PidMode &&
        (this.#backend.mode !== 'rootful' || !gateway.HostConfig.UsernsMode) &&
        digest(gateway.HostConfig.CapDrop) === digest(['ALL']) &&
        !gateway.HostConfig.CapAdd?.length &&
        digest(gateway.HostConfig.SecurityOpt) === digest(['no-new-privileges']) &&
        digest(gateway.Config.Entrypoint) === digest(['node']) &&
        digest(gateway.Config.Cmd) === digest(['/proxy.mjs']) &&
        sameContainerEnvironment(gateway.Config.Env, gatewayEnvironment) &&
        gateway.Mounts?.length === 1 + extraMounts.length &&
        gateway.Mounts.some(mount => mount.Source === c.proxyScript &&
          mount.Destination === '/proxy.mjs' &&
          mount.Type === 'bind' && mount.RW === false) &&
        extraMounts.every(expected => gateway.Mounts.some(mount =>
          mount.Source === expected.Source &&
          mount.Destination === expected.Destination &&
          mount.Type === 'bind' && mount.RW === false)) &&
        /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) &&
        Object.keys(network.Containers ?? {}).every((id) => id === c.gatewayId),
      'AGENT_EGRESS_NOT_ISOLATED',
    );
    return {
      proxyHost: ip,
      proxyUrl: `http://${ip}:3128`,
      imageId: images[0].Id,
      imageEnv: images[0].Config?.Env ?? [],
      observationHash: digest({
        daemon,
        apparmor,
        network,
        gateway,
        source: sha256(source),
      }),
    };
  }
  async execute({ plan, executionId, work, main, input, output, session, auth,
    mcp = null }) {
    const c = this.#config;
    requireThat(
      plan?.policyHash ===
        digest({ config: plan.config, requirements: plan.requirements }) &&
        /^[a-f0-9-]{36}$/.test(executionId),
      'INVALID_AGENT_PLAN',
    );
    requireThat((plan.mcpPolicyHash ?? null) === (mcp?.policyHash ?? null),
      'USER_MCP_PROFILE_CHANGED');
    const paths = [work, main, input, output, session, auth];
    for (const path of paths) {
      requireThat(
        typeof path === 'string' &&
          isAbsolute(path) &&
          !/[,\x00-\x1f]/.test(path) &&
          (await this.#host.realpath(path)) === resolve(path),
        'UNSAFE_AGENT_MOUNT',
      );
      const stat = await this.#host.lstat(path);
      requireThat(
        path === auth ? stat.isFile() && stat.nlink === 1 : stat.isDirectory(),
        'NONREGULAR_AGENT_MOUNT',
      );
    }
    requireThat(
      paths.every((path, i) =>
        paths.every(
          (other, j) => i === j || (path !== other && !path.startsWith(`${other}/`)),
        ),
      ),
      'OVERLAPPING_AGENT_MOUNTS',
    );
    const preflight = await this.preflight();
    const seccompPath = join(c.coreRoot, 'src/security/seccomp.json');
    const seccomp = JSON.parse(await readFile(seccompPath, 'utf8'));
    const security = [
      'no-new-privileges',
      `seccomp=${JSON.stringify(seccomp)}`,
      'apparmor=codex-security-container',
    ];
    const bootstrap = await readFile(join(c.coreRoot, 'src/codex-bootstrap.mjs'));
    await writeFile(join(input, 'bootstrap.mjs'), bootstrap,
      { flag: 'wx', mode: 0o400 });
    await writeFile(
      join(input, 'invocation.json'),
      JSON.stringify({
        plan,
        codexVersion: c.codexVersion,
        proxyHost: preflight.proxyHost,
      }),
      { flag: 'wx', mode: 0o400 },
    );
    await writeFile(join(input, 'requirements.toml'), plan.requirements, {
      flag: 'wx',
      mode: 0o400,
    });
    for (const [path, writable] of [
      [work, plan.writable],
      [main, false],
      [input, false],
      [output, true],
      [session, true],
    ]) {
      await shareAgentMount(path, writable);
    }
    await privateMountParent(output);
    const authRoot = await mkdtemp(join(dirname(output), 'agent-auth-'));
    const authCopy = join(authRoot, 'auth.json');
    await copyFile(auth, authCopy);
    await chmod(authCopy, 0o444);
    const mounts = [
      { source: main, destination: '/main', rw: false },
      { source: work, destination: '/work', rw: plan.writable },
      { source: input, destination: '/input', rw: false },
      { source: output, destination: '/io', rw: true },
      { source: session, destination: '/agent-home', rw: true },
      { source: authCopy, destination: '/auth/auth.json', rw: false },
      {
        source: join(input, 'requirements.toml'),
        destination: '/etc/codex/requirements.toml',
        rw: false,
      },
    ];
    if (mcp) {
      const path = join(authRoot, 'mcp.toml');
      await writeFile(path, privateMcpToml(mcp), { flag: 'wx', mode: 0o444 });
      mounts.push({ source: path, destination: '/auth/mcp.toml', rw: false });
    }
    const name = `nibfin-agent-${randomUUID()}`;
    const environment = {
      ...plan.environment,
      HTTP_PROXY: preflight.proxyUrl,
      HTTPS_PROXY: preflight.proxyUrl,
      ALL_PROXY: preflight.proxyUrl,
      NO_PROXY: '',
    };
    const expectedEnv = Object.fromEntries(
      preflight.imageEnv.map((entry) => [
        entry.slice(0, entry.indexOf('=')),
        entry.slice(entry.indexOf('=') + 1),
      ]),
    );
    Object.assign(expectedEnv, environment);
    const args = [
      'create',
      '--init',
      '--pull=never',
      '--name',
      name,
      '--read-only',
      '--network',
      c.network,
      '--ipc',
      'none',
      '--dns',
      '127.0.0.1',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--security-opt',
      `seccomp=${seccompPath}`,
      '--security-opt=apparmor=codex-security-container',
      '--pids-limit=256',
      '--memory=4g',
      '--cpus=2',
      '--user',
      '1000:1000',
      '--tmpfs',
      '/tmp:rw,exec,nosuid,nodev,size=2g,mode=1777',
      '--workdir',
      '/session',
      ...mounts.flatMap((m) => [
        '--mount',
        `type=bind,src=${m.source},dst=${m.destination}${m.rw ? '' : ',readonly'}` +
          ',bind-propagation=rprivate,bind-recursive=disabled',
      ]),
      ...Object.entries(environment).flatMap(([key, value]) => [
        '--env',
        `${key}=${value}`,
      ]),
      '--entrypoint',
      '/usr/local/bin/node',
      c.image,
      '/input/bootstrap.mjs',
    ];
    let id,
      observed,
      mcpLease,
      outcome = { status: 'denied', executionId, code: 'AGENT_ENTRY_DENIED' };
    try {
      if (mcp?.metadata.hosts.length) {
        requireThat(c.mcpPolicyDirectory, 'USER_MCP_EGRESS_NOT_ADOPTED');
        mcpLease = await acquireMcpEgress(c.mcpPolicyDirectory, executionId,
          mcp.metadata.hosts);
      }
      id = (await this.#docker(args)).stdout.toString().trim();
      requireThat(/^[a-f0-9]{64}$/.test(id), 'AGENT_CONTAINER_UNKNOWN');
      const actual = await this.#inspect(['inspect', id]);
      requireThat(actual.length === 1, 'AGENT_CONTAINER_UNKNOWN');
      observed = actual[0];
      const host = observed.HostConfig;
      const observedEnv = observed.Config?.Env ?? [];
      requireThat(
        sameContainerEnvironment(observedEnv, Object.entries(expectedEnv)
          .map(([key, value]) => `${key}=${value}`)),
        'AGENT_ENVIRONMENT_CHANGED',
      );
      requireThat(
        observed.Id === id &&
          observed.Name === `/${name}` &&
          observed.State?.Status === 'created' &&
          observed.Image === preflight.imageId &&
          observed.Config.Image === c.image &&
          observed.Config.User === '1000:1000' &&
          observed.Config.WorkingDir === '/session' &&
          digest(observed.Config.Entrypoint) === digest(['/usr/local/bin/node']) &&
          digest(observed.Config.Cmd) === digest(['/input/bootstrap.mjs']) &&
          host.Privileged === false &&
          (this.#backend.mode !== 'rootful' || !host.UsernsMode) &&
          host.ReadonlyRootfs === true &&
          host.Init === true &&
          host.NetworkMode === c.network &&
          host.IpcMode === 'none' &&
          !host.PidMode &&
          host.Memory === 4294967296 &&
          host.NanoCpus === 2000000000 &&
          host.PidsLimit === 256 &&
          digest(host.CapDrop) === digest(['ALL']) &&
          digest(host.SecurityOpt) === digest(security) &&
          observed.AppArmorProfile === 'codex-security-container' &&
          !host.CapAdd?.length &&
          !host.Devices?.length &&
          !host.DeviceRequests?.length &&
          !host.PublishAllPorts &&
          !host.AutoRemove &&
          observed.Mounts?.length === mounts.length &&
          mounts.every((expected) =>
            observed.Mounts.some(
              (m) =>
                m.Type === 'bind' &&
                m.Source === expected.source &&
                m.Destination === expected.destination &&
                m.RW === expected.rw,
            ),
          ),
        'AGENT_CONTAINER_POLICY_MISMATCH',
      );
      const entryExitCodes = [
        0, codexIdle.exitCode, ...Object.values(codexPreflightExits),
      ];
      let attached;
      try {
        attached = await this.#docker(['start', '--attach', id], {
          timeout: deliveryRoleTimeout,
          allowedExitCodes: entryExitCodes,
        });
      } catch (error) {
        if (!['PROCESS_TIMEOUT', 'PROCESS_FAILED'].includes(error.code)) throw error;
        outcome = { status: 'interrupted', executionId, code: error.code };
      }
      if (outcome.status !== 'interrupted') {
        const ended = (await this.#inspect(['inspect', id]))[0];
        requireThat(
          ended.Id === id &&
            ended.State?.Running === false &&
            entryExitCodes.includes(ended.State.ExitCode) &&
            ended.State.OOMKilled === false,
          'AGENT_CONTAINER_FAILED',
        );
        const code = ended.State.ExitCode === codexIdle.exitCode ? codexIdle.code :
          Object.keys(codexPreflightExits)
            .find(reason => codexPreflightExits[reason] === ended.State.ExitCode);
        if (code === codexIdle.code) {
          const diagnostic = idleDiagnostic(attached.stderr.toString());
          console.error(diagnostic ?? 'NIBFIN_IDLE_PROGRESS unavailable');
        }
        outcome = code
          ? { status: 'interrupted', executionId, code }
          : { status: 'executed', executionId };
      }
    } catch {
      outcome = { status: 'denied', executionId, code: 'AGENT_EXECUTION_UNVERIFIED' };
    } finally {
      let cleanupStep = 'container removal';
      try {
        const exists = (
          await this.#docker(['ps', '-aq', '--filter', `name=^/${name}$`])
        ).stdout
          .toString()
          .trim();
        if (exists) {
          requireThat(/^[a-f0-9]{12,64}$/.test(exists), 'AMBIGUOUS_AGENT_CLEANUP');
          await this.#docker(['rm', '--force', name]);
        }
        requireThat(
          !(await this.#docker(['ps', '-aq', '--filter', `name=^/${name}$`])).stdout
            .toString()
            .trim(),
          'AGENT_STILL_RUNNING',
        );
        const discard = !mcp || outcome.status === 'interrupted';
        cleanupStep = 'MCP lease release';
        if (discard) await mcpLease?.release();
        // Mapped UID files must be host-readable/removable before any proof.
        cleanupStep = 'writable mount reclamation';
        const cleanupMounts = mounts.filter((m) => m.rw);
        await this.#docker([
          'run',
          '--rm',
          '--network',
          'none',
          '--read-only',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--user',
          '1000:1000',
          '--pids-limit=64',
          '--memory=256m',
          '--cpus=1',
          ...cleanupMounts.flatMap((m) => [
            '--mount',
            `type=bind,src=${m.source},dst=${m.destination},bind-recursive=disabled`,
          ]),
          '--entrypoint',
          '/usr/local/bin/node',
          c.image,
          '-e',
          cleanupAgentMounts,
          ...cleanupMounts.map((m) => m.destination),
        ]);
        cleanupStep = 'credential and session removal';
        if (discard) {
          await rm(authRoot, { recursive: true });
          for (const entry of await readdir(session))
            await rm(join(session, entry), { recursive: true, force: true });
        }
        if (['executed', 'interrupted'].includes(outcome.status))
          outcome.terminationHash = digest({
            executionId,
            containerId: id,
            name,
            absent: true,
          });
      } catch {
        console.error(`Nibfin agent cleanup failed during ${cleanupStep}`);
        outcome = { status: 'pending', executionId, code: 'WRITER_TERMINATION_UNKNOWN' };
      }
    }
    if (outcome.status === 'executed') {
      const terminationHash = outcome.terminationHash;
      try {
        const proof = await privateJSON(join(output, 'probe.json'), 16384);
        requireThat(
          proof.policyHash === plan.policyHash &&
            proof.codexVersion === c.codexVersion &&
            proof.stdout === 'NIBFIN_PROBE_PASSED\n',
          'AGENT_PROBE_MISSING',
        );
        const stream = await privateJSON(join(output, 'stream.json'), 16 * 1024 * 1024);
        requireThat(
          typeof stream.stdout === 'string' &&
            typeof stream.stderr === 'string' &&
            Object.keys(stream).sort().join(',') === 'stderr,stdout',
          'AGENT_STREAM_MISSING',
        );
        outcome = {
          status: 'completed',
          executionId,
          terminationHash,
          ...(mcp ? { retireMcp: async () => {
            await mcpLease?.release();
            await rm(authRoot, { recursive: true });
            for (const entry of await readdir(session))
              await rm(join(session, entry), { recursive: true, force: true });
          } } : {}),
          stdout: stream.stdout,
          stderr: stream.stderr,
          policyHash: plan.policyHash,
          probeHash: digest(proof),
          isolationHash: digest({
            preflight,
            container: observed,
            bootstrap: sha256(bootstrap),
            ...(mcp ? { mcpPolicyHash: mcp.policyHash,
              mcpEgressHash: mcpLease?.hash ?? null } : {}),
          }),
        };
      } catch {
        outcome = { status: 'denied', executionId, code: 'AGENT_OUTPUT_UNVERIFIED' };
      }
    }
    return outcome;
  }
}
