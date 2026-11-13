import {
  lstat, realpath, mkdtemp, mkdir, writeFile, readFile, rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { command } from './process.mjs';
import { requireThat } from './identity.mjs';
import {
  dockerBackend, validDockerEndpoint, verifyDockerSocket, dockerInfo,
} from './docker-backend.mjs';
import { verifyAppArmor } from './apparmor-proof.mjs';
import {
  requestedTools, toolPlatform, supportedToolPlatform,
} from './tool-catalog.mjs';
import { preparationRecipe, versionProbe } from './tool-recipe.mjs';

// Match trusted Docker diagnostics internally; never forward installer output.
function buildFailure(result) {
  const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  const failures = [
    [/network bridge not found/i, 'TOOL_BUILD_NETWORK_BRIDGE_MISSING'],
    [new RegExp('failed to (?:resolve source metadata|fetch oauth token)|' +
      'manifest unknown|pull access denied', 'i'), 'TOOL_BUILD_ACQUISITION_FAILED'],
    [/no space left on device/i, 'TOOL_BUILD_STORAGE_EXHAUSTED'],
    [/cannot connect to the docker daemon/i, 'TOOL_BUILD_DAEMON_UNAVAILABLE'],
    [/\/nonexistent[^\n]*permission denied/i, 'TOOL_BUILD_CONFIG_PERMISSION_DENIED'],
    [/failed to mount[^\n]*(?:permission denied|operation not permitted)/i,
      'TOOL_BUILD_MOUNT_DENIED'],
    [/permission denied/i, 'TOOL_BUILD_PERMISSION_DENIED'],
  ];
  return failures.find(([pattern]) => pattern.test(output))?.[1] ??
    'TOOL_BUILD_FAILED';
}

const immutable = /^sha256:[a-f0-9]{64}$/;
export class ToolPreparationError extends Error {
  constructor(phase, reason = 'failed', diagnosticCode = 'TOOL_PREPARATION_FAILED') {
    super(`Tool environment ${phase}: ${reason}`);
    this.code = 'TOOL_PREPARATION_FAILED';
    this.phase = phase;
    this.diagnosticCode = diagnosticCode;
  }
}

// Host-side only. Configuration and dependencies are supplied by trusted Core,
// never by repository declarations. No job admission or global image switching.
export class ToolEnvironmentPreparer {
  #config;
  #backend;
  #host;
  #run;
  #pending = new Map();
  constructor(config, {
    backend, run = command,
    host = { platform: process.platform, uid: process.getuid?.(), lstat, realpath },
  } = {}) {
    this.#backend = dockerBackend(backend);
    requireThat(config && Object.keys(config).sort().join(',') === 'docker,socket' &&
      validDockerEndpoint(config, this.#backend), 'INVALID_TOOL_PREPARATION_CONFIG');
    this.#config = structuredClone(config);
    this.#host = host;
    this.#run = run;
  }
  async #docker(args, options = {}) {
    return this.#run(this.#config.docker,
      ['--host', `unix://${this.#config.socket}`, ...args], {
        timeout: 30000, limit: 8 * 1024 * 1024, ...options,
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/nonexistent',
          DOCKER_CONFIG: '/nonexistent', DOCKER_BUILDKIT: '1', ...options.env },
      });
  }
  async prepare(value) {
    let tools;
    try { tools = requestedTools(value); }
    catch (error) {
      // ENV-01 errors contain field/reason only, never arbitrary installer output.
      throw new ToolPreparationError('request', error.message.slice(0, 200));
    }
    if (!Object.keys(tools).length) return null;
    const key = JSON.stringify(tools);
    if (this.#pending.has(key)) return this.#pending.get(key);
    const pending = this.#prepare(tools);
    this.#pending.set(key, pending);
    try { return await pending; }
    finally { this.#pending.delete(key); }
  }
  async #inspect(reference, recipe) {
    const result = await this.#docker(['image', 'inspect', reference],
      { allowedExitCodes: [0, 1] });
    if (result.exitCode === 1) return null;
    const images = JSON.parse(result.stdout.toString());
    if (!Array.isArray(images) || images.length !== 1) return null;
    const image = images[0];
    return immutable.test(image.Id) &&
      (reference === image.Id || !immutable.test(reference)) &&
      supportedToolPlatform(image.Os, image.Architecture) &&
      image.Config?.Labels?.['io.nibfin.tool-environment'] === recipe.key
      ? image.Id : null;
  }
  async #validate(image, tools, recipe) {
    // Reuse the existing native AppArmor/namespace enforcement probe.
    if (this.#backend.mode === 'rootful') {
      let target, uncertain = false;
      try {
        await verifyAppArmor(async (args, opts) => {
          if (args.includes('--name')) target = args[args.indexOf('--name') + 1];
          try { return await this.#docker(args, opts); }
          catch (error) {
            if (['ps', 'rm'].includes(args[0])) uncertain = true;
            throw error;
          }
        }, image, this.#backend.namespace);
      } catch (error) {
        if (!uncertain && !error.code?.includes('TERMINATION_UNKNOWN')) throw error;
        const failure = new ToolPreparationError('cleanup',
          `termination unknown for ${target}`);
        failure.code = 'WRITER_TERMINATION_UNKNOWN';
        throw failure;
      }
    }
    const name = `nibfin-tools-${randomUUID()}`;
    try {
      const result = await this.#docker([
        'run', '--rm', '--pull=never', '--name', name,
        '--read-only', '--network=none', '--ipc=none', '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        ...(this.#backend.mode === 'rootful'
          ? ['--security-opt=apparmor=codex-security-container'] : []),
        '--user=1000:1000', '--pids-limit=64', '--memory=512m', '--cpus=1',
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=1777',
        '--entrypoint', '/usr/local/bin/node', image, '-e',
        versionProbe(tools, recipe.versions),
      ], { timeout: 90000, limit: 65536, allowedExitCodes: [0, 1, 125, 126, 127] });
      if (result.exitCode) {
        const output = result.stderr.toString();
        const probe = /\bNIBFIN_TOOL_PROBE_[A-Z0-9_]+\b/.exec(output)?.[0];
        const code = probe ?? ({
          125: 'TOOL_PROBE_DOCKER_FAILED',
          126: 'TOOL_PROBE_NOT_EXECUTABLE',
          127: 'TOOL_PROBE_EXECUTABLE_MISSING',
        }[result.exitCode] ?? 'TOOL_PROBE_FAILED');
        throw new ToolPreparationError('image validation', code, code);
      }
      requireThat(result.stdout.toString() === 'NIBFIN_TOOLS_VERIFIED\n',
        'TOOL_VERSION_MISMATCH');
    } finally {
      const remaining = async () => (await this.#docker([
        'ps', '-aq', '--filter', `name=^/${name}$`,
      ])).stdout.toString().trim();
      try {
        const id = await remaining();
        if (id) {
          requireThat(/^[a-f0-9]{12,64}$/.test(id), 'AMBIGUOUS_TOOL_CONTAINER');
          await this.#docker(['rm', '--force', name]);
        }
        requireThat(!(await remaining()), 'TOOL_CONTAINER_STILL_PRESENT');
      } catch {
        // Keep the reconciliation target. A timeout is not proof of termination.
        const error = new ToolPreparationError('cleanup',
          `termination unknown for ${name}`);
        error.code = 'WRITER_TERMINATION_UNKNOWN';
        throw error;
      }
    }
  }
  async #prepare(tools) {
    let phase = 'backend', temporaryRoot;
    try {
      await verifyDockerSocket(this.#config.socket, this.#backend, this.#host);
      const info = JSON.parse((await this.#docker([
        'info', '--format', '{{json .}}',
      ])).stdout.toString());
      dockerInfo(info, this.#backend);
      requireThat(supportedToolPlatform(info.OSType, info.Architecture),
        'UNSUPPORTED_TOOL_PLATFORM');
      phase = 'recipe';
      const recipe = await preparationRecipe(tools);
      const tag = `nibfin-tools:${recipe.key}`;
      phase = 'cache validation';
      const cached = await this.#inspect(tag, recipe);
      if (cached) {
        await this.#validate(cached, tools, recipe);
        return cached;
      }
      phase = 'build';
      temporaryRoot = await mkdtemp(join(tmpdir(), 'nibfin-tools-'));
      const context = join(temporaryRoot, 'context');
      const buildx = join(temporaryRoot, 'buildx');
      const dockerConfig = join(temporaryRoot, 'docker-config');
      const imageId = join(temporaryRoot, 'image-id');
      await mkdir(context, { mode: 0o700 });
      await mkdir(buildx, { mode: 0o700 });
      await mkdir(dockerConfig, { mode: 0o700 });
      await writeFile(join(context, 'Dockerfile'), recipe.dockerfile, { mode: 0o600 });
      // This context contains only the maintained composition, no repository
      // files, secrets, credentials, supplied URLs or host installation scripts.
      const result = await this.#docker(['build', '--platform', toolPlatform,
        '--iidfile', imageId, context], {
        timeout: 20 * 60_000,
        // Buildx also uses Docker CLI state outside its own configuration.
        // Keep that state writable, empty and isolated from host credentials.
        env: { BUILDX_CONFIG: buildx, DOCKER_CONFIG: dockerConfig },
        allowedExitCodes: Array.from({ length: 256 }, (_, code) => code),
      });
      if (result.exitCode !== 0) {
        const code = buildFailure(result);
        throw new ToolPreparationError(phase, code, code);
      }
      const built = (await readFile(imageId, 'utf8')).trim();
      requireThat(immutable.test(built), 'INVALID_PREPARED_IMAGE');
      phase = 'image validation';
      const image = await this.#inspect(built, recipe);
      requireThat(image === built, 'INCOMPATIBLE_PREPARED_IMAGE');
      await this.#validate(image, tools, recipe);
      phase = 'cache publication';
      // Publish only a fully verified image. Equal contracts may race safely;
      // distinct versions/recipes never share a mutable tag.
      await this.#docker(['image', 'tag', image, tag]);
      return image;
    } catch (error) {
      if (error instanceof ToolPreparationError) throw error;
      const known = /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code ?? '')
        ? error.code : 'TOOL_PREPARATION_FAILED';
      throw new ToolPreparationError(phase,
        error.code === 'PROCESS_TIMEOUT' ? 'timed out' : 'failed',
        error.code === 'PROCESS_TIMEOUT'
          ? 'TOOL_PREPARATION_TIMEOUT' : known);
    } finally {
      if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}
