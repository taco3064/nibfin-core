import { readFile } from 'node:fs/promises';
import { digest } from './identity.mjs';
import { toolPlatform, toolSource, projectToolPath } from './tool-catalog.mjs';

export async function preparationRecipe(tools) {
  const base = await readFile(new URL('./security/agent.Dockerfile', import.meta.url),
    'utf8');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const codex = /^ARG CODEX_VERSION=(\S+)$/m.exec(base)?.[1];
  if (!codex) throw new Error('Missing maintained Codex version');
  // Name the maintained final stage; its contents remain the sole Agent recipe.
  const lines = base.trimEnd().split('\n');
  const lastFrom = lines.findLastIndex(line => line.startsWith('FROM '));
  lines[lastFrom] += ' AS nibfin-agent';
  for (const [name, version] of Object.entries(tools))
    lines.push(`FROM ${toolSource(name, version)} AS project-${name}`);
  lines.push('FROM nibfin-agent', 'RUN mkdir -p /opt/nibfin/project/bin');
  if (tools.node) lines.push(
    'COPY --from=project-node /usr/local/ /opt/nibfin/project/node/',
    'RUN for x in node npm npx; do ln -s ../node/bin/$x ' +
      '/opt/nibfin/project/bin/$x; done',
  );
  if (tools.python) lines.push(
    'RUN apt-get update && apt-get install -y --no-install-recommends ' +
      'libbz2-1.0 libexpat1 libffi8 libgdbm6 libgdbm-compat4 liblzma5 ' +
      'libncursesw6 libreadline8 libsqlite3-0 libssl3 libuuid1 zlib1g ' +
      '&& rm -rf /var/lib/apt/lists/*',
    'COPY --from=project-python /usr/local/ /opt/nibfin/project/python/',
    'RUN printf \'#!/bin/sh\\nexec /opt/nibfin/project/python/bin/python3 "$@"\\n\' ' +
      '> /opt/nibfin/project/bin/python3 ' +
      '&& chmod 755 /opt/nibfin/project/bin/python3 ' +
      '&& ln -s python3 /opt/nibfin/project/bin/python ' +
      '&& printf \'#!/bin/sh\\nexec python3 -m pip "$@"\\n\' ' +
      '> /opt/nibfin/project/bin/pip ' +
      '&& chmod 755 /opt/nibfin/project/bin/pip ' +
      '&& ln -s pip /opt/nibfin/project/bin/pip3',
  );
  if (tools.go) lines.push(
    'COPY --from=project-go /usr/local/go/ /opt/nibfin/project/go/',
    'RUN printf \'#!/bin/sh\\nGOTOOLCHAIN=local exec ' +
      '/opt/nibfin/project/go/bin/go "$@"\\n\' ' +
      '> /opt/nibfin/project/bin/go ' +
      '&& chmod 755 /opt/nibfin/project/bin/go ' +
      '&& ln -s ../go/bin/gofmt /opt/nibfin/project/bin/gofmt',
  );
  const versions = { node: pkg.engines.node, codex: `codex-cli ${codex}` };
  // The key binds all maintained inputs that can change compatibility. It is a
  // cache address, never an authorization prerequisite or an owner-facing pin.
  const key = digest({ recipe: lines, platform: toolPlatform, tools, versions,
    probe: versionProbe(tools, versions) });
  lines.push(`LABEL io.nibfin.tool-environment="${key}"`, '');
  return { dockerfile: lines.join('\n'), key, versions };
}

// Execute only trusted commands with a fixed bootstrap runtime. The development
// PATH is tested independently; Codex and its Node wrapper use the fixed PATH.
export function versionProbe(tools, versions) {
  return `
const {execFileSync} = require('node:child_process');
const check = (file, args, expected, path, input) => {
  const tool = file.split('/').at(-1).toUpperCase().replace(/[^A-Z0-9]/g, '_');
  let result;
  try {
    result = execFileSync(file, args, {
        env: {PATH: path, HOME: '/tmp', GOTOOLCHAIN: 'local'},
      timeout: 15000, maxBuffer: 65536, encoding: 'utf8', input,
    }).trim();
  } catch {
    throw Error('NIBFIN_TOOL_PROBE_' + tool + '_COMMAND_FAILED');
  }
  if (expected !== undefined && result !== expected)
    throw Error('NIBFIN_TOOL_PROBE_' + tool + '_VERSION_MISMATCH');
};
const fixed = '/usr/local/bin:/usr/bin:/bin';
const project = ${JSON.stringify(projectToolPath)};
check('/usr/local/bin/node', ['--version'], ${JSON.stringify('v' + versions.node)},
  fixed);
check('/usr/local/bin/codex', ['--version'], ${JSON.stringify(versions.codex)}, fixed);
const tools = ${JSON.stringify(tools)};
if (tools.node) {
  check('node', ['--version'], 'v' + tools.node, project);
  for (const file of ['npm', 'npx']) check(file, ['--version'], undefined, project);
}
if (tools.python) {
  check('python3', ['--version'], 'Python ' + tools.python, project);
  check('python3', ['-c', 'import ssl, sqlite3, bz2, lzma, ctypes'],
    undefined, project);
  for (const file of ['pip', 'pip3']) check(file, ['--version'], undefined, project);
}
if (tools.go) {
  check('go', ['env', 'GOVERSION'], 'go' + tools.go, project);
  check('gofmt', [], 'package probe', project, 'package probe\\n');
}
process.stdout.write('NIBFIN_TOOLS_VERIFIED\\n');
`;
}
