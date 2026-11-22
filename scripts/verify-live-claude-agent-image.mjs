// Build the managed Agent and Claude Agent recipes exactly as Core resolves them,
// then check the Claude image without credentials, network or inference, confined
// as Core confines it: the Claude AppArmor profile with the Codex seccomp profile.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command } from '../src/process.mjs';
import { linuxArchitecture } from '../src/linux-architecture.mjs';
import {
  agentVersions, managedAgentRecipe, prepareAgentInputs, resolvedClaudeRecipe,
} from '../src/agent-image-inputs.mjs';
import {
  derivedRecipe, platformTag, requireDerivedLayers,
} from '../src/managed-derived-image.mjs';
import { claudeAppArmorProfile, claudeToolShell } from '../src/claude-agent-plan.mjs';
import { liveDockerProfile } from './live-docker-profile.mjs';

const text = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const context = fileURLToPath(new URL('../src/security', import.meta.url));
const anyExit = Array.from({ length: 256 }, (_, code) => code);
const seccomp = fileURLToPath(new URL('../src/security/seccomp.json', import.meta.url));
// Core mounts this trusted bootstrap read-only at /input/bootstrap.mjs.
const bootstrap = fileURLToPath(new URL('../src/claude-bootstrap.mjs', import.meta.url));

// Drives the bootstrap's own probes: every environ read is denied (self, threads,
// tasks, a sibling holding a sentinel and the parent) and the bubblewrap sandbox
// still hides state and the network. Ordinary procfs status stays readable.
export const probeModule = [
  "import { readFileSync } from 'node:fs';",
  "import { denialProbe } from '/input/bootstrap.mjs';",
  "if (!readFileSync('/proc/self/status', 'utf8').startsWith('Name:'))",
  "  throw new Error('NIBFIN_PROC_STATUS_UNREADABLE');",
  "try { await denialProbe('127.0.0.1'); } catch (error) {",
  '  console.error(error.cause?.message ?? error.message);',
  '  process.exit(1);',
  '}',
  "console.log('NIBFIN_CLAUDE_APPARMOR_VERIFIED');",
].join('\n');

// Core's Claude confinement, without credentials or network.
export function confinement() {
  return ['--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--security-opt', `seccomp=${seccomp}`,
    '--security-opt', `apparmor=${claudeAppArmorProfile}`, '--user', '1000:1000',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=1777'];
}

// A failing RUN's own error lines, wherever they appear in the build output.
const errorLine = /runc|\bERROR\b|^\S*\s*E: |\bErr:|\berror\b|npm ERR!/i;

// CI diagnostics: the failing command's error lines, then the end of its stderr,
// bounded in lines and width. Only credential-free build and probe output reaches
// this path.
export function failureTail(stderr, lines = 40, width = 300) {
  const all = String(stderr).split('\n').filter(line => line.trim());
  const tail = all.slice(-lines);
  const errors = all.slice(0, -lines).filter(line => errorLine.test(line))
    .slice(-20);
  return [...errors, ...(errors.length ? ['...'] : []), ...tail]
    .map(line => line.slice(0, width)).join('\n');
}

// Every Docker call reports its step, exit code and stderr tail on failure.
export function diagnosedDocker(run, socket, progress, log = console.error) {
  return async (args, { input } = {}) => {
    const result = await run('/usr/bin/docker',
      ['--host', `unix://${socket}`, ...args], {
        env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
        input, timeout: 30 * 60 * 1000, allowedExitCodes: anyExit,
      });
    if (result.exitCode !== 0) {
      log(`NIBFIN_CLAUDE_IMAGE_STEP_FAILED step=${progress.step} ` +
        `command=docker ${args[0]} exit=${result.exitCode}`);
      log(failureTail(result.stderr.toString()));
      throw Object.assign(new Error('PROCESS_FAILED'),
        { code: 'PROCESS_FAILED', exitCode: result.exitCode });
    }
    return result.stdout.toString();
  };
}

async function verify(progress) {
  const { socket, backend } = liveDockerProfile();
  const docker = diagnosedDocker(command, socket, progress);
  // Build-context files the recipes COPY, and the profiles and bootstrap the
  // container runs under; scripts/test-changes.mjs selects this check from these
  // literals and the imported resolvers.
  for (const path of ['src/security/nibfin-bash', 'src/security/claude-package.mjs',
    'src/security/managed-npm/package-lock.json',
    'src/security/codex-security.apparmor', 'src/claude-bootstrap.mjs'])
    assert((await text(path)).length > 0, path);
  const profile = await text('src/security/nibfin-claude.apparmor');
  assert(profile.includes(`\nprofile ${claudeAppArmorProfile} `));
  // The profile assertions need the host AppArmor policy; they never skip.
  assert.equal(backend.mode, 'rootful', 'the Claude AppArmor check needs rootful Docker');
  const architecture = linuxArchitecture('linux', process.arch);
  const agent = await text('src/security/agent.Dockerfile');
  const claudeRecipe = await text('src/security/managed-claude-agent.Dockerfile');
  const versions = agentVersions(agent, JSON.parse(await text('package.json')),
    JSON.parse(await text('src/security/managed-npm/package.json')),
    await text('src/security/claude-package.mjs'));
  progress.step = 'resolve and pull Agent inputs';
  const native = await prepareAgentInputs(agent, architecture, docker);
  const scratch = await mkdtemp(join(tmpdir(), 'nibfin-claude-image-'));
  // Core's managed build flags except `--network=host`: on the userns-remapped CI
  // daemon a RUN in the host network namespace cannot mount sysfs, so the build
  // uses the daemon's default network like the other CI image builds. Plain
  // progress keeps a failing RUN's own output in the diagnostics.
  const build = async (name, recipe) => {
    progress.step = `build ${name}`;
    const iid = join(scratch, `${name}.iid`);
    await docker(['build', '--no-cache', '--progress=plain',
      '--platform', native.platform, '--iidfile', iid, '--file', '-', context],
    { input: recipe });
    const id = (await readFile(iid, 'utf8')).trim();
    assert.match(id, /^sha256:[a-f0-9]{64}$/);
    return id;
  };
  const images = [];
  // Core's managed Agent tag, which derived recipes build FROM.
  const base = platformTag('agent', architecture);
  let tagged = false;
  let container;
  try {
    const agentImage = await build('managed-agent', managedAgentRecipe(
      await text('src/security/managed-agent.Dockerfile'), native, versions));
    images.push(agentImage);
    progress.step = 'tag managed-agent';
    await docker(['image', 'tag', agentImage, base]);
    tagged = true;
    progress.step = 'resolve claude-agent';
    const recipe = await derivedRecipe(resolvedClaudeRecipe(claudeRecipe,
      versions.claude), agentImage, architecture, docker);
    const image = await build('claude-agent', recipe);
    images.push(image);
    progress.step = 'inspect layers and labels';
    const [row] = JSON.parse(await docker(['image', 'inspect', image]));
    await requireDerivedLayers(row, agentImage, docker);
    const labels = row.Config.Labels;
    assert.equal(`${labels['io.nibfin.claude-version']} (Claude Code)`,
      versions.claude);
    assert.equal(labels['io.nibfin.claude-managed-settings'], 'absent');
    assert.equal(labels['io.nibfin.resource-kind'], 'claude-agent');
    // The recipe's own absence proof, rechecked in the built image.
    const absent = [...claudeRecipe.matchAll(/test ! -e (\S+)/g)].map(m => m[1]);
    assert(absent.includes('/usr/local/bin/codex') &&
      absent.includes('/root/.claude'));
    const script = [
      'set -eu', 'mkdir -p /tmp/home/.claude',
      '/opt/nibfin/claude/bin/claude --version',
      '/usr/bin/bwrap --version >/dev/null', '/usr/bin/socat -V >/dev/null',
      `test -x ${claudeToolShell}`,
      ...absent.map(path => `test ! -e ${path}`), 'echo NIBFIN_CLAUDE_IMAGE_VERIFIED',
    ].join('\n');
    progress.step = 'run image checks';
    // Run as uid 1000 on a read-only root; Claude's state goes under /tmp only.
    const output = await docker(['run', '--rm', ...confinement(),
      '--env', 'HOME=/tmp/home', '--env', 'CLAUDE_CONFIG_DIR=/tmp/home/.claude',
      '--entrypoint', '/bin/sh', image, '-c', script]);
    assert.equal(output, `${versions.claude}\nNIBFIN_CLAUDE_IMAGE_VERIFIED\n`);
    progress.step = 'run AppArmor probes';
    // Core's mount points: the read-only bootstrap and empty /agent-home and /io.
    container = (await docker(['create', ...confinement(), '--mount',
      `type=bind,source=${bootstrap},target=/input/bootstrap.mjs,readonly`,
      '--tmpfs', '/agent-home', '--tmpfs', '/io', '--workdir', '/',
      '--entrypoint', '/usr/local/bin/node', image,
      '--input-type=module', '-e', probeModule])).trim();
    assert.match(container, /^[a-f0-9]{64}$/);
    assert.equal(await docker(['start', '--attach', container]),
      'NIBFIN_CLAUDE_APPARMOR_VERIFIED\n');
    progress.step = 'inspect AppArmor profile';
    const [run] = JSON.parse(await docker(['container', 'inspect', container]));
    assert.equal(run.AppArmorProfile, claudeAppArmorProfile);
  } finally {
    // Cleanup reports under its own step and never replaces the failing step.
    const cleanup = diagnosedDocker(command, socket, { step: 'cleanup' });
    if (container)
      await cleanup(['container', 'rm', '--force', container]).catch(() => {});
    if (tagged) await cleanup(['image', 'rm', base]).catch(() => {});
    for (const image of images.reverse())
      await cleanup(['image', 'rm', '--force', image]).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const progress = { step: 'setup' };
  try {
    await verify(progress);
    console.log('Claude agent image verified');
  } catch (error) {
    console.error(`NIBFIN_CLAUDE_IMAGE_CHECK_FAILED step=${progress.step} ` +
      `code=${error.code ?? error.name}`);
    // Assertion and resolver messages name facts, never command output.
    if (!String(error.code).startsWith('PROCESS_'))
      console.error(String(error.message).slice(0, 2000));
    process.exitCode = 1;
  }
}
