import { parseProjectConfig } from './project-config.mjs';
import { linuxArchitecture } from './linux-architecture.mjs';

// Official Debian bookworm images are the only acquisition sources. Keep the
// finite version list here; exact executable versions are checked after build.
export const toolCatalog = Object.freeze({
  node: Object.freeze(['22.15.0', '24.22.1']),
  python: Object.freeze(['3.13.7']),
  go: Object.freeze(['1.27.1']),
});
export const projectToolPath =
  '/opt/nibfin/project/bin:/usr/local/bin:/usr/bin:/bin';

const toolManifests = {
  'node:22.15.0': {
    amd64: '01cbafb3480d272d73613e5e74206ec79326f4a9ebb4d089f636b53d12d87a04',
    arm64: '71ecda08bfca53d2b72a727056be374eea4a0ba53cf0de1a947ec8068f4e0918',
  },
  'node:24.22.1': {
    amd64: 'e1582112fb9f152ed38eefcd712efc93fee1becb519fdfa57574d5e07eaa5e7d',
    arm64: '932a44adcdb8f5dfbf00f00eb38da8d22b450b2ad258b6d1b2319beca823bfbd',
  },
  'python:3.13.7': {
    amd64: '781449467ffb6f04218f09b1ecdcdc7d22b289ee5da9ec498b024e24ad7a6db7',
    arm64: 'fcf02c9e248b995ae2ca9aac6fa24b489f34b589dbfdc44698ad245d2ad41d1e',
  },
  'go:1.27.1': {
    amd64: 'e114385c58e7280d2f56d6cf374219dda33fef8eb77f72e9f290ccae6160bd90',
    arm64: '27da97ffaed4bbb1263c44a8e423a72a1547830ee14a70fdb0cef3f6268a1b8b',
  },
};

export function requestedTools(value) {
  if (value === undefined) return {};
  if (value && typeof value === 'object' &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error('Expected normalized tools object');
  const { tools } = parseProjectConfig({ tools: value });
  const result = {};
  for (const name of Object.keys(toolCatalog)) {
    if (!Object.hasOwn(tools, name)) continue;
    const version = tools[name];
    if (!toolCatalog[name].includes(version))
      throw new Error(`Unsupported project tool: ${name} ${version.slice(0, 64)}`);
    result[name] = version;
  }
  return result;
}

export function toolSource(name, version, architecture) {
  const arch = linuxArchitecture('linux', architecture);
  const manifest = toolManifests[`${name}:${version}`]?.[arch];
  if (!manifest) throw Object.assign(new Error('Unsupported tool image'), {
    code: 'UNSUPPORTED_TOOL_IMAGE',
  });
  const image = name === 'go' ? 'golang' : name;
  return `docker.io/library/${image}@sha256:${manifest}`;
}
