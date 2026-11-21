// Build the managed Agent and Claude Agent recipes exactly as Core resolves them,
// then check the Claude image without credentials, network or inference.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { command } from '../src/process.mjs';
import { linuxArchitecture } from '../src/linux-architecture.mjs';
import {
  agentVersions, managedAgentRecipe, prepareAgentInputs, resolvedClaudeRecipe,
} from '../src/agent-image-inputs.mjs';
import { claudeToolShell } from '../src/claude-agent-plan.mjs';
import { liveDockerProfile } from './live-docker-profile.mjs';

const text = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const context = new URL('../src/security', import.meta.url).pathname;
const { socket, backend } = liveDockerProfile();
const docker = async (args, { input } = {}) => (await command('/usr/bin/docker',
  ['--host', `unix://${socket}`, ...args], {
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' },
    input, timeout: 30 * 60 * 1000,
  })).stdout.toString();

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
const native = await prepareAgentInputs(agent, architecture, docker);
const build = async recipe => {
  const id = (await docker(['build', '--quiet', '--platform', native.platform,
    '--file', '-', context], { input: recipe })).trim();
  assert.match(id, /^sha256:[a-f0-9]{64}$/);
  return id;
};
const images = [];
try {
  images.push(await build(managedAgentRecipe(
    await text('src/security/managed-agent.Dockerfile'), native, versions)));
  const image = await build(resolvedClaudeRecipe(claudeRecipe, images[0],
    versions.claude));
  images.push(image);
  const [row] = JSON.parse(await docker(['image', 'inspect', image]));
  const labels = row.Config.Labels;
  assert.equal(`${labels['io.nibfin.claude-version']} (Claude Code)`,
    versions.claude);
  assert.equal(labels['io.nibfin.claude-managed-settings'], 'absent');
  assert.equal(labels['io.nibfin.resource-kind'], 'claude-agent');
  // The recipe's own absence proof, rechecked in the built image.
  const absent = [...claudeRecipe.matchAll(/test ! -e (\S+)/g)].map(m => m[1]);
  assert(absent.includes('/usr/local/bin/codex') && absent.includes('/root/.claude'));
  const script = [
    'set -eu', 'mkdir -p /tmp/home/.claude',
    '/opt/nibfin/claude/bin/claude --version',
    '/usr/bin/bwrap --version >/dev/null', '/usr/bin/socat -V >/dev/null',
    `test -x ${claudeToolShell}`,
    ...absent.map(path => `test ! -e ${path}`), 'echo NIBFIN_CLAUDE_IMAGE_VERIFIED',
  ].join('\n');
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
  for (const image of images.reverse())
    await docker(['image', 'rm', '--force', image]).catch(() => {});
}
console.log('Claude agent image verified');
