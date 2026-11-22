// Build the managed Agent and Claude Agent recipes exactly as Core resolves them,
// then check the Claude image without credentials, network or inference.
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
import { claudeToolShell } from '../src/claude-agent-plan.mjs';
import { liveDockerProfile } from './live-docker-profile.mjs';

const text = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const context = fileURLToPath(new URL('../src/security', import.meta.url));
const anyExit = Array.from({ length: 256 }, (_, code) => code);

// CI diagnostics: the end of a failing command's stderr, bounded in lines and
// width. Only credential-free build and probe output reaches this path.
export function failureTail(stderr, lines = 40, width = 300) {
  return String(stderr).split('\n').filter(line => line.trim()).slice(-lines)
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
  // Build-context files the recipes COPY; scripts/test-changes.mjs selects this
  // check from these literals and the imported resolvers.
  for (const path of ['src/security/nibfin-bash', 'src/security/claude-package.mjs',
    'src/security/managed-npm/package-lock.json'])
    assert((await text(path)).length > 0, path);
  const architecture = linuxArchitecture('linux', process.arch);
  const agent = await text('src/security/agent.Dockerfile');
  const claudeRecipe = await text('src/security/managed-claude-agent.Dockerfile');
  const versions = agentVersions(agent, JSON.parse(await text('package.json')),
    JSON.parse(await text('src/security/managed-npm/package.json')),
    await text('src/security/claude-package.mjs'));
  progress.step = 'resolve and pull Agent inputs';
  const native = await prepareAgentInputs(agent, architecture, docker);
  const scratch = await mkdtemp(join(tmpdir(), 'nibfin-claude-image-'));
  // Core's managed build flags, plus plain progress so a failing RUN shows its
  // own output in the stderr tail.
  const build = async (name, recipe) => {
    progress.step = `build ${name}`;
    const iid = join(scratch, `${name}.iid`);
    await docker(['build', '--no-cache', '--network=host', '--progress=plain',
      '--platform', native.platform, '--iidfile', iid, '--file', '-', context],
    { input: recipe });
    const id = (await readFile(iid, 'utf8')).trim();
    assert.match(id, /^sha256:[a-f0-9]{64}$/);
    return id;
  };
  const images = [];
  try {
    images.push(await build('managed-agent', managedAgentRecipe(
      await text('src/security/managed-agent.Dockerfile'), native, versions)));
    const image = await build('claude-agent', resolvedClaudeRecipe(claudeRecipe,
      images[0], versions.claude));
    images.push(image);
    progress.step = 'inspect labels';
    const [row] = JSON.parse(await docker(['image', 'inspect', image]));
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
    const output = await docker(['run', '--rm', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      ...(backend.mode === 'rootful'
        ? ['--security-opt', 'apparmor=codex-security-container'] : []),
      '--user', '1000:1000', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=1777',
      '--env', 'HOME=/tmp/home', '--env', 'CLAUDE_CONFIG_DIR=/tmp/home/.claude',
      '--entrypoint', '/bin/sh', image, '-c', script]);
    assert.equal(output, `${versions.claude}\nNIBFIN_CLAUDE_IMAGE_VERIFIED\n`);
  } finally {
    progress.step = 'cleanup';
    for (const image of images.reverse())
      await docker(['image', 'rm', '--force', image]).catch(() => {});
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
