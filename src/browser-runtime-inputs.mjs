// These are the native shared-library inputs of the maintained Chromium-ready
// Agent profile, not a request to install a browser for every project. Browser
// binaries and their versions remain owned by the project's native lockfile.
const libraries = [
  'libgio-2.0.so.0', 'libgobject-2.0.so.0',
  'libglib-2.0.so.0', 'libnspr4.so', 'libnss3.so', 'libdbus-1.so.3',
  'libatk-1.0.so.0', 'libatk-bridge-2.0.so.0', 'libatspi.so.0',
  'libX11.so.6', 'libXcomposite.so.1', 'libXdamage.so.1', 'libXext.so.6',
  'libXfixes.so.3', 'libXrandr.so.2', 'libgbm.so.1', 'libxcb.so.1',
  'libxkbcommon.so.0', 'libasound.so.2', 'libcups.so.2', 'libdrm.so.2',
  'libpango-1.0.so.0', 'libcairo.so.2',
];

export function browserRuntimeProbe(architecture) {
  const triplet = { amd64: 'x86_64', arm64: 'aarch64' }[architecture];
  if (!triplet) throw Object.assign(new Error('Unsupported browser runtime'), {
    code: 'RESOURCE_INPUT_PLATFORM_UNSUPPORTED',
  });
  return `
const {execFileSync} = require('node:child_process');
const {existsSync} = require('node:fs');
const directory = '/usr/lib/${triplet}-linux-gnu/';
const libraries = ${JSON.stringify(libraries, null, 2)};
try {
  for (const library of libraries) {
    const path = directory + library;
    if (!existsSync(path)) throw Error('missing');
    const result = execFileSync('/usr/bin/ldd', [path], {
      timeout: 5000, maxBuffer: 65536, encoding: 'utf8',
      env: {PATH: '/usr/bin:/bin', LANG: 'C'},
    });
    if (result.includes('not found')) throw Error('dependency');
  }
  const font = execFileSync('/usr/bin/fc-match', ['--format=%{file}', 'sans'], {
    timeout: 5000, maxBuffer: 65536, encoding: 'utf8',
    env: {PATH: '/usr/bin:/bin', HOME: '/tmp'},
  });
  if (!font || !existsSync(font)) throw Error('font');
} catch { throw Error('NIBFIN_BROWSER_RUNTIME_UNAVAILABLE'); }
process.stdout.write('NIBFIN_BROWSER_RUNTIME_VERIFIED\\n');
`;
}
