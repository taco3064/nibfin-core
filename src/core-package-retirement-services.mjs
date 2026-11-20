import { realpath } from 'node:fs/promises';
import { command } from './process.mjs';
import { requireThat } from './identity.mjs';
import { fileURLToPath } from 'node:url';

const options = { env: { PATH: '/usr/bin:/bin', LANG: 'C' } };
const properties = ['ExecStart', 'ExecStartPre', 'ExecStartPost', 'ExecStop',
  'ExecStopPost', 'ExecReload', 'ExecCondition', 'WorkingDirectory', 'RootDirectory',
  'RootImage', 'Environment', 'ReadOnlyPaths', 'ReadWritePaths',
  'MountImages', 'ExtensionImages', 'ExtensionDirectories',
  'BindPaths', 'BindReadOnlyPaths', 'EnvironmentFiles', 'FragmentPath',
  'DropInPaths', 'StandardInputFile', 'StandardOutputFile', 'StandardErrorFile'];
const unitName = /^[A-Za-z0-9@_.:\\-]+\.service$/;
const unavailable = 'PACKAGE_SERVICE_OBSERVATION_UNAVAILABLE';
const decode = text => text.replace(/\\x([a-fA-F0-9]{2})/g,
  (_, hex) => String.fromCharCode(parseInt(hex, 16)));

async function requireNoResolvedReference(path, reference) {
  requireThat(!reference.test(path), 'PACKAGE_SERVICE_REFERENCE');
  let resolved;
  try { resolved = await realpath(path); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return;
    requireThat(false, 'PACKAGE_SERVICE_OBSERVATION_UNAVAILABLE');
  }
  requireThat(!reference.test(resolved), 'PACKAGE_SERVICE_REFERENCE');
}

async function requireNoFileURLReferences(text, reference, root = '') {
  // Runtime arguments can name executable source with file URLs. Decode with
  // the runtime's native URL rules, including escapes and localhost authority.
  for (const [url] of text.matchAll(/(?<![A-Za-z0-9+.-])file:[^\s"'<>;{}]+/gi)) {
    let path;
    try { path = fileURLToPath(url); }
    catch {
      requireThat(false, 'PACKAGE_SERVICE_OBSERVATION_UNAVAILABLE');
    }
    await requireNoResolvedReference(root + path, reference);
  }
}

const property = (text, name) =>
  text.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1] ?? '';
const absolutePaths = /(?:^|[\s="':;{(])([/][^\s"';}:)]+)/g;

async function requireNoCommandReferences(text, reference) {
  const root = property(text, 'RootDirectory');
  const commands = text.split('\n').filter(line => line.startsWith('Exec'));
  requireThat(!commands.some(line => reference.test(line)),
    'PACKAGE_SERVICE_REFERENCE');
  if (property(text, 'RootImage')) return;
  const working = property(text, 'WorkingDirectory').replace(/^-/, '') || '/';
  for (const line of commands) {
    await requireNoFileURLReferences(line, reference, root);
    for (const [, source] of line.matchAll(/\bpath=(\/.*?) ;/g))
      await requireNoResolvedReference(root + source, reference);
  }
  for (const [, executable, argv] of commands.join('\n').matchAll(
    /(?:\bpath=(.*?) ; )?argv\[\]=(.*?) ;/g)) {
    // systemctl show renders argv, not a shell command. Quoted simple tokens
    // are supported; unresolved expansion or serialization is uncertainty.
    const tokens = argv.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? [];
    if (executable) tokens.shift(); // argv[0] can be an arbitrary process name.
    for (let token of tokens) {
      token = token.replace(/^(["'])(.*)\1$/, '$2');
      if (token.startsWith('-')) {
        const equals = token.indexOf('=');
        if (equals < 0) continue;
        token = token.slice(equals + 1);
      }
      if (!token || /^file:/i.test(token)) continue;
      if (token.startsWith('/')) {
        await requireNoResolvedReference(root + token, reference);
        continue;
      }
      if (!working.startsWith('/')) {
        if (token.includes('/'))
          requireThat(false, 'PACKAGE_SERVICE_OBSERVATION_UNAVAILABLE');
        continue;
      }
      // Do not normalize .. before realpath: an intermediate symlink changes
      // its native meaning. A bare word is a possible file only if it resolves.
      await requireNoResolvedReference(root + working + '/' + token, reference);
    }
  }
}

function observedServices(output, units) {
  const claimed = new Map();
  const records = new Map();
  for (const record of output.trim().split(/\n\n+/)) {
    const id = property(record, 'Id');
    const names = property(record, 'Names').split(/ +/).filter(Boolean);
    requireThat(unitName.test(id) && names.every(name => unitName.test(name)),
      unavailable);
    const selected = [id, ...names].filter(name => units.has(name));
    requireThat(selected.length > 0 &&
      (!records.has(id) || records.get(id).record === record), unavailable);
    for (const name of selected) {
      requireThat(!claimed.has(name) || claimed.get(name) === id, unavailable);
      claimed.set(name, id);
    }
    records.set(id, { record, installed: selected.some(name => units.get(name)) });
  }
  requireThat(claimed.size === units.size, unavailable);
  return records.values();
}

// Query systemd's effective source-bearing properties for loaded AND installed
// services, including disabled/inactive units. Do not inspect arbitrary files.
export async function requireNoPackageServices(path, run = command) {
  const names = new Map();
  for (const operation of ['list-unit-files', 'list-units']) {
    const args = [operation, '--type=service', '--no-legend', '--no-pager',
      ...(operation === 'list-units' ? ['--all', '--plain'] : [])];
    const { stdout } = await run('/usr/bin/systemctl', args, options);
    for (const line of stdout.toString().split('\n').filter(line => line.trim())) {
      const name = line.trim().split(/\s+/)[0];
      requireThat(unitName.test(name), unavailable);
      // The manager exposes effective properties on concrete instances.
      if (name.endsWith('@.service')) continue;
      names.set(name, operation === 'list-unit-files' || names.get(name) === true);
    }
  }
  if (!names.size) return;
  const fields = ['Id', 'Names', 'NeedDaemonReload', 'LoadState', ...properties];
  const { stdout } = await run('/usr/bin/systemctl',
    ['show', '--property=' + fields.join(','), '--', ...names.keys()], options);
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reference = new RegExp(`(?:^|[\\s="':;{])${escaped}(?=$|[/\\s"';}:])`);
  for (const { record, installed } of observedServices(stdout.toString(), names)) {
    const text = decode(record);
    // A loaded dependency placeholder can have no service definition.
    if (!installed && property(text, 'LoadState') === 'not-found' &&
      !property(text, 'FragmentPath') && property(text, 'NeedDaemonReload') === 'no')
      continue;
    requireThat(/^NeedDaemonReload=no$/m.test(text) &&
      /^LoadState=(loaded|masked)$/m.test(text),
    'PACKAGE_SERVICE_OBSERVATION_UNAVAILABLE');
    await requireNoCommandReferences(text, reference);
    const host = text.split('\n').filter(line => !line.startsWith('Exec') &&
      !line.startsWith('WorkingDirectory=')).join('\n');
    requireThat(!reference.test(host), 'PACKAGE_SERVICE_REFERENCE');
    await requireNoFileURLReferences(host, reference);
    const working = property(text, 'WorkingDirectory').replace(/^-/, '');
    if (working.startsWith('/') && !property(text, 'RootImage'))
      await requireNoResolvedReference(property(text, 'RootDirectory') + working,
        reference);
    for (const [, source] of host.replace(/file:[^\s"'<>;{}]+/gi, '')
      .matchAll(absolutePaths)) {
      await requireNoResolvedReference(source, reference);
    }
  }
}
