import { lstat, realpath, mkdir, writeFile, chmod, unlink, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import limits from './claude-work-limits.json' with { type: 'json' };
import { randomUUID } from 'node:crypto';
import { command } from './process.mjs';
import { OfflineSandbox } from './sandbox.mjs';
import { dockerBackend } from './docker-backend.mjs';
import { digest, requireThat } from './identity.mjs';
import { shareAgentMount, privateMountParent } from './agent-mounts.mjs';
import { verifyWorkEgress } from './claude-work-egress.mjs';
import { roleCapabilities } from './provider-contract.mjs';
import {
  claudeWorkChannel, claudeWorkSocket, claudeTools, bindClaudeWorkChannel,
} from './claude-work-channel.mjs';
import {
  workContainerArgs, inspectWorkContainer, workEnvironment,
} from './claude-work-container.mjs';

// One instance per trusted admission. No model-supplied launch options exist.
// The composing runner must call settle on every exit, and requireSettlement
// before reporting model completion or releasing a Writer/session fence.
export class ClaudeWorkWorker {
  #config;
  #backend;
  #egress;
  #run;
  #host;
  #admission;
  #name;
  #launched = false;
  #active = false;
  #settled;
  #mounts;
  #files = [];
  #starting;
  #stopping;
  #timer;
  #channel;
  constructor(config, admission, { run = command, host, backend, egress } = {}) {
    this.#backend = dockerBackend(backend);
    requireThat(this.#backend.mode === 'rootful', 'CLAUDE_WORK_REQUIRES_REMAP');
    // Reuse the existing Docker endpoint/image validation and enforced probes.
    new OfflineSandbox(config, { run, host, backend: this.#backend });
    bindClaudeWorkChannel(admission.stage, admission.executionId);
    const n = this.#backend.namespace, p = admission.peer;
    requireThat(p && Number.isSafeInteger(p.uid) && Number.isSafeInteger(p.gid) &&
      p.uid > n.uidStart && p.uid < n.uidStart + n.size &&
      p.gid > n.gidStart && p.gid < n.gidStart + n.size &&
      p.uid !== n.uidStart + 1000 && p.gid !== n.gidStart + 1000,
    'CLAUDE_WORK_PEER_NOT_DISTINCT');
    this.#egress = structuredClone(egress);
    this.#config = structuredClone(config);
    this.#admission = structuredClone(admission);
    this.#run = run;
    this.#host = host;
    this.#name = `nibfin-claude-work-${randomUUID()}`;
  }
  async #docker(args, options = {}) {
    return this.#run(this.#config.docker,
      ['--host', `unix://${this.#config.socket}`, ...args], {
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/nonexistent',
          DOCKER_CONFIG: '/nonexistent' }, timeout: 30000, limit: 262144, ...options,
      });
  }
  start() {
    requireThat(!this.#starting, 'CLAUDE_WORK_ALREADY_LAUNCHED');
    this.#starting = this.#start();
    return this.#starting;
  }
  async #start() {
    requireThat(!this.#launched, 'CLAUDE_WORK_ALREADY_LAUNCHED');
    this.#launched = true;
    const a = this.#admission;
    try {
      const paths = [a.work, a.main, a.input, a.session];
      for (const path of paths) {
        requireThat(typeof path === 'string' && path === resolve(path) &&
          !/[,\x00-\x1f]/.test(path) && await realpath(path) === path &&
          (await lstat(path)).isDirectory(), 'CLAUDE_WORK_UNSAFE_MOUNT');
        await privateMountParent(path);
      }
      requireThat(paths.every((p, i) => paths.every((q, j) => i === j ||
        p !== q && !p.startsWith(`${q}/`))), 'CLAUDE_WORK_OVERLAPPING_MOUNT');
      const preflight = await new OfflineSandbox(this.#config, {
        run: this.#run, host: this.#host, backend: this.#backend,
      }).preflight();
      const egress = await verifyWorkEgress(this.#egress,
        args => this.#docker(args));
      const writable = roleCapabilities(a.stage).workspace === 'write';
      for (const [path, write] of [[a.work, writable], [a.main, false],
        [a.input, false]]) await shareAgentMount(path, write);
      // The controller owns the private 0700 parent. Only this execution's
      // remapped worker and model see the shared child, never other sessions.
      const channel = join(a.session, 'work-channel');
      await mkdir(channel, { mode: 0o777 });
      this.#channel = channel;
      await chmod(channel, 0o777);
      const admission = join(a.session, 'work-admission.json');
      const n = this.#backend.namespace;
      const authorize = bindClaudeWorkChannel(a.stage, a.executionId);
      const operations = claudeTools(a.stage).map(tool => tool.split('__').at(-1));
      for (const operation of operations) authorize(a.executionId, operation);
      await writeFile(admission, JSON.stringify({
        channel: claudeWorkChannel, socket: claudeWorkSocket,
        lifetime: limits.lifetimeSeconds,
        executionId: a.executionId, stage: a.stage,
        peer: [a.peer.uid - n.uidStart, a.peer.gid - n.gidStart],
        operations,
        environment: Object.fromEntries(workEnvironment(egress).map(value => {
          const split = value.indexOf('=');
          return [value.slice(0, split), value.slice(split + 1)];
        })),
      }), { flag: 'wx', mode: 0o644 });
      this.#files.push(admission);
      await chmod(admission, 0o644);
      this.#mounts = [
        { source: a.work, target: '/work' }, { source: a.main, target: '/main' },
        { source: a.input, target: '/input' },
        { source: admission, target: '/session/work-admission.json' },
        { source: channel, target: '/session/work-channel' },
      ];
      // Create may take effect even if its response is lost: mark active first
      // and reconcile by the unique Core-owned name on all failure paths.
      const images = JSON.parse((await this.#docker([
        'image', 'inspect', this.#config.image,
      ])).stdout);
      const inherited = (images[0]?.Config?.Env ?? []).map(value =>
        value.slice(0, value.indexOf('=')));
      requireThat(inherited.every(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)),
        'CLAUDE_WORK_INVALID_IMAGE_ENV');
      this.#active = true;
      const id = (await this.#docker(workContainerArgs(
        this.#config, this.#name, this.#mounts, writable, inherited, egress)))
        .stdout.toString().trim();
      requireThat(/^[a-f0-9]{64}$/.test(id), 'CLAUDE_WORK_UNKNOWN_CONTAINER');
      const observed = JSON.parse((await this.#docker(['inspect', id])).stdout);
      requireThat(Array.isArray(observed) && observed.length === 1,
        'CLAUDE_WORK_AMBIGUOUS_CONTAINER');
      inspectWorkContainer(observed[0], { config: this.#config, name: this.#name,
        id, mounts: this.#mounts, writable, egress });
      await this.#docker(['start', id]);
      await this.#ready(join(channel, 'worker.sock'), id);
      this.#timer = setTimeout(() => { void this.settle(); },
        limits.lifetimeSeconds * 1000);
      this.#timer.unref();
      return { channel: claudeWorkChannel, executionId: a.executionId,
        stage: a.stage, socket: join(channel, 'worker.sock'),
        isolationHash: digest({ preflight, egress, container: observed[0] }) };
    } catch {
      await this.#settle();
      throw new Error('CLAUDE_WORK_START_DENIED');
    }
  }
  async #ready(path, id) {
    const host = this.#host ?? { lstat, realpath };
    for (let attempt = 0; attempt < 50; attempt++) {
      const actual = JSON.parse((await this.#docker(['inspect', id])).stdout)[0];
      requireThat(actual?.Id === id && actual.State?.Running === true,
        'CLAUDE_WORK_NOT_RUNNING');
      try {
        const stat = await host.lstat(path);
        requireThat(stat.isSocket() && await host.realpath(path) === path &&
          stat.uid === this.#backend.namespace.uidStart + 1000 &&
          stat.gid === this.#backend.namespace.gidStart + 1000 &&
          (stat.mode & 0o777) === 0o666, 'CLAUDE_WORK_SOCKET_SUBSTITUTED');
        return;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('CLAUDE_WORK_SOCKET_UNAVAILABLE');
  }
  async settle() {
    if (this.#starting) {
      try { await this.#starting; } catch { /* Reconcile a failed start too. */ }
    }
    if (this.#stopping) return this.#stopping;
    this.#stopping = this.#settle();
    try { return await this.#stopping; } finally { this.#stopping = undefined; }
  }
  async #settle() {
    clearTimeout(this.#timer);
    if (this.#settled) return this.#settled;
    requireThat(this.#launched, 'CLAUDE_WORK_NOT_LAUNCHED');
    try {
      if (this.#active) {
        const remaining = async () => (await this.#docker([
          'ps', '-aq', '--filter', `name=^/${this.#name}$`,
        ])).stdout.toString().trim();
        const id = await remaining();
        if (id) {
          requireThat(/^[a-f0-9]{12,64}$/.test(id), 'CLAUDE_WORK_AMBIGUOUS_CLEANUP');
          await this.#docker(['rm', '--force', this.#name]);
        }
        requireThat(!await remaining(), 'CLAUDE_WORK_STILL_PRESENT');
      }
      const settled = { status: 'terminated', executionId: this.#admission.executionId,
        terminationHash: digest({ name: this.#name, absent: true }) };
      // Leave workspace ownership and Candidate capture to the composing runner.
      // Remove only admission data; channel disposal follows proven settlement.
      for (const path of this.#files) await unlink(path);
      this.#files = [];
      if (this.#channel) await rm(this.#channel, { recursive: true, force: true });
      clearTimeout(this.#timer);
      this.#settled = settled;
      return settled;
    } catch {
      return { status: 'unknown', executionId: this.#admission.executionId,
        code: 'WRITER_TERMINATION_UNKNOWN' };
    }
  }
  requireSettlement() {
    requireThat(this.#settled?.status === 'terminated',
      'WRITER_TERMINATION_UNKNOWN');
    return this.#settled;
  }
}

// The downstream model runner owns its own termination proof. This wrapper
// adds the worker obligation on every model completion, cancellation and error.
export async function withClaudeWorkWorker(worker, execute, { signal } = {}) {
  const cancel = () => { void worker.settle(); };
  try {
    const handoff = await worker.start();
    if (signal?.aborted) throw new Error('CLAUDE_WORK_INTERRUPTED');
    signal?.addEventListener('abort', cancel, { once: true });
    return await execute(handoff);
  } finally {
    signal?.removeEventListener('abort', cancel);
    await worker.settle();
    worker.requireSettlement();
  }
}
