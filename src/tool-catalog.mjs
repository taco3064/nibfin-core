import { parseProjectConfig } from './project-config.mjs';

// Official Debian bookworm images are the only acquisition sources. Keep the
// finite version list here; exact executable versions are checked after build.
export const toolCatalog = Object.freeze({
  node: Object.freeze(['22.15.0', '24.22.1']),
  python: Object.freeze(['3.13.7']),
  go: Object.freeze(['1.27.1']),
});
export const toolPlatform = 'linux/amd64';
export const projectToolPath =
  '/opt/nibfin/project/bin:/usr/local/bin:/usr/bin:/bin';

export function supportedToolPlatform(os, architecture) {
  const arch = architecture === 'x86_64' ? 'amd64' : architecture;
  return `${os}/${arch}` === toolPlatform;
}

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

export function toolSource(name, version) {
  // Only callers with a validated catalog selection can reach composition.
  if (!toolCatalog[name]?.includes(version)) throw new Error('Unsupported tool');
  const images = {
    node: `node:${version}-bookworm-slim`,
    python: `python:${version}-slim-bookworm`,
    go: `golang:${version}-bookworm`,
  };
  return `docker.io/library/${images[name]}`;
}
