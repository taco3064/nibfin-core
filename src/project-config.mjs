import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve, win32 } from 'node:path';
import { exactProjectHost } from './egress-proxy.mjs';

const names = ['tools', 'allowedDomains', 'skills'];
const tools = ['node', 'python', 'go'];
const roles = ['shape', 'deliver', 'accept'];
const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export class ProjectConfigError extends Error {
  constructor(field, reason) {
    super(`.nibfin.json: ${field}: ${reason}`);
    this.code = 'PROJECT_CONFIG_INVALID';
  }
}
function invalid(field, reason) {
  throw new ProjectConfigError(field, reason);
}
function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid(field, 'expected an object');
}
function keys(value, allowed, field) {
  object(value, field);
  if (Object.keys(value).some(key => !allowed.includes(key)))
    invalid(field, 'unsupported property');
}
function domain(value, field) {
  if (!exactProjectHost(value))
    invalid(field, 'expected a complete public destination domain');
  return value;
}
function skillPath(value, field) {
  if (typeof value !== 'string' || !value || value.trim() !== value ||
      value.includes('\\') || value.includes(':') || /[\x00-\x1f\x7f]/.test(value) ||
      value.startsWith('/') || win32.isAbsolute(value) ||
      value.split('/').some(part => !part || part === '..' || part === '.'))
    invalid(field, 'expected a repository-relative file path without traversal');
  return value;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function parseProjectConfig(value) {
  keys(value, names, 'root');
  const result = {};
  if (Object.hasOwn(value, 'tools')) {
    keys(value.tools, tools, 'tools');
    result.tools = {};
    for (const [name, version] of Object.entries(value.tools)) {
      if (typeof version !== 'string' || version.trim() !== version ||
          !exactVersion.test(version))
        invalid(`tools.${name}`, 'expected an exact major.minor.patch version');
      result.tools[name] = version;
    }
  }
  if (Object.hasOwn(value, 'allowedDomains')) {
    if (!Array.isArray(value.allowedDomains))
      invalid('allowedDomains', 'expected an array');
    result.allowedDomains = value.allowedDomains.map((value, index) =>
      domain(value, `allowedDomains[${index}]`));
  }
  if (Object.hasOwn(value, 'skills')) {
    keys(value.skills, roles, 'skills');
    result.skills = {};
    for (const [name, entry] of Object.entries(value.skills)) {
      const field = `skills.${name}`;
      keys(entry, ['mode', 'path'], field);
      if (!['extend', 'override'].includes(entry.mode))
        invalid(`${field}.mode`, 'expected extend or override');
      result.skills[name] = {
        mode: entry.mode, path: skillPath(entry.path, `${field}.path`),
      };
    }
  }
  return freeze(result);
}

export async function readProjectConfig(work) {
  const file = join(resolve(work), '.nibfin.json');
  let stat;
  try { stat = await lstat(file); }
  catch (error) {
    if (error.code === 'ENOENT') return parseProjectConfig({});
    invalid('file', 'cannot inspect configuration');
  }
  if (!stat.isFile() || await realpath(file).catch(() => null) !== file)
    invalid('file', 'expected a regular file in the target work tree');
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch { invalid('file', 'cannot read configuration'); }
  let value;
  try { value = JSON.parse(text); }
  catch { invalid('root', 'invalid JSON'); }
  return parseProjectConfig(value);
}
