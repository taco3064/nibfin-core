import { spawn } from 'node:child_process';

const invalid = 'CLAUDE_PRIVATE_MODEL_INPUT_INVALID';
try {
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error(invalid);
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString());
  if (typeof input.prompt !== 'string' ||
    Buffer.byteLength(input.prompt) > 1024 * 1024 ||
    typeof input.key !== 'string')
    throw new Error(invalid);
  // A self-contained copy of Core's two credential kinds: this file has no imports.
  const variable = /^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{20,500}$/.test(input.key)
    ? 'CLAUDE_CODE_OAUTH_TOKEN'
    : /^sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,500}$/.test(input.key)
      ? 'ANTHROPIC_API_KEY' : undefined;
  if (!variable) throw new Error(invalid);
  const env = Object.fromEntries([
    'PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
    'DISABLE_AUTOUPDATER', 'HTTPS_PROXY', 'HTTP_PROXY',
  ].map(key => [key, process.env[key]]));
  env[variable] = input.key;
  const child = spawn('/opt/nibfin/claude/bin/claude', process.argv.slice(2),
    { cwd: '/session', env, stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.on('error', () => {});
  child.stdin.end(input.prompt);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  process.exitCode = code ?? 1;
} catch {
  process.stderr.write(invalid + '\n');
  process.exitCode = 1;
}
