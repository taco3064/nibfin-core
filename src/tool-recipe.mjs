import { readFile } from 'node:fs/promises';
import { digest, requireThat } from './identity.mjs';
import { toolSource, projectToolPath } from './tool-catalog.mjs';
import { linuxArchitecture } from './linux-architecture.mjs';

const project = '/opt/nibfin/project';
const pythonLibraries = [
  'libbz2.so.1*', 'libcrypto.so.3', 'libexpat.so.1*', 'libffi.so.8*',
  'libgdbm.so.6*', 'libgdbm_compat.so.4*', 'liblzma.so.5*', 'libncursesw.so.6*',
  'libreadline.so.8*', 'libsqlite3.so.0*', 'libssl.so.3', 'libtinfo.so.6*',
  'libuuid.so.1*', 'libz.so.1*',
];

export async function preparationRecipe(tools, baseImage, arch = process.arch) {
  const architecture = linuxArchitecture('linux', arch);
  requireThat(architecture, 'UNSUPPORTED_TOOL_PLATFORM');
  const platform = `linux/${architecture}`;
  requireThat(/^sha256:[a-f0-9]{64}$/.test(baseImage), 'INVALID_TOOL_BASE_IMAGE');
  const maintained = await readFile(
    new URL('./security/agent.Dockerfile', import.meta.url), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const codex = /^ARG CODEX_VERSION=(\S+)$/m.exec(maintained)?.[1];
  if (!codex) throw new Error('Missing maintained Codex version');
  const baseTag = `nibfin-tool-base:${baseImage.slice(7)}`;
  const lines = Object.entries(tools).map(([name, version]) =>
    `FROM ${toolSource(name, version, architecture)} AS project-${name}`);
  lines.push(`FROM ${baseTag}`);
  const wrappers = {};
  const wrapper = (name, exec) => {
    wrappers[name] = `#!/bin/sh\n${exec} "$@"\n`;
  };
  if (tools.node) {
    lines.push(`COPY --from=project-node /usr/local/ ${project}/node/`);
    for (const name of ['node', 'npm', 'npx'])
      wrapper(name, `exec ${project}/node/bin/${name}`);
  }
  if (tools.python) {
    lines.push(`COPY --from=project-python /usr/local/ ${project}/python/`);
    for (const lib of pythonLibraries) {
      const triplet = architecture === 'amd64' ? 'x86_64' : 'aarch64';
      const source = `/usr/lib/${triplet}-linux-gnu/${lib}`;
      lines.push(`COPY --from=project-python ${source} ${project}/python/lib/`);
    }
    for (const name of ['python', 'python3', 'pip', 'pip3']) {
      const pip = name.startsWith('pip') ? ' -m pip' : '';
      wrapper(name, `LD_LIBRARY_PATH=${project}/python/lib ` +
        `exec ${project}/python/bin/python3${pip}`);
    }
  }
  if (tools.go) {
    lines.push(`COPY --from=project-go /usr/local/go/ ${project}/go/`);
    wrapper('go', `GOTOOLCHAIN=local exec ${project}/go/bin/go`);
    wrapper('gofmt', `exec ${project}/go/bin/gofmt`);
  }
  lines.push(`COPY --chmod=0755 bin/ ${project}/bin/`);
  const versions = { node: pkg.engines.node, codex: `codex-cli ${codex}` };
  // The key binds all maintained inputs that can change compatibility. It is a
  // cache address, never an authorization prerequisite or an owner-facing pin.
  const key = digest({ recipe: lines, wrappers, platform, tools, versions,
    probe: versionProbe(tools, versions) });
  lines.push(`LABEL io.nibfin.tool-environment="${key}"`, '');
  return { dockerfile: lines.join('\n'), wrappers, baseTag, key, versions, platform,
    architecture };
}

// Execute only trusted commands with a fixed bootstrap runtime. The development
// PATH is tested independently; Codex and its Node wrapper use the fixed PATH.
export function versionProbe(tools, versions, {
  codex = true, npm,
} = {}) {
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
${codex ? `check('/usr/local/bin/codex', ['--version'],
  ${JSON.stringify(versions.codex)}, fixed);` : ''}
${npm ? `check('/usr/local/bin/npm', ['--version'],
  ${JSON.stringify(npm)}, fixed);` : ''}
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
