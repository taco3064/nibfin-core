import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { withinPackage } from './package-use.mjs';

const execute = promisify(execFile);
const systemctl = async args => (await execute('systemctl',
  [...args, '--no-pager'], { encoding: 'utf8' })).stdout;

// Installed unit files matter even when stopped. Loaded units also include
// transient services. Never emit unit contents or command lines in diagnostics.
export async function observePackageServices(candidate, {
  run = systemctl, canonical = realpath,
} = {}) {
  try {
    const files = await run(['list-unit-files', '--type=service', '--no-legend']);
    const loaded = await run(['list-units', '--all', '--type=service', '--plain',
      '--no-legend']);
    const activeNames = new Set(loaded.split('\n').filter(line => line.trim() &&
      !['inactive', 'failed'].includes(line.trim().split(/\s+/)[2]))
      .map(line => line.trim().split(/\s+/)[0]));
    const masked = new Set(files.split('\n').filter(line =>
      /\s+masked(?:-runtime)?(?:\s|$)/.test(line))
      .map(line => line.trim().split(/\s+/)[0]));
    const names = new Set([...files.split('\n'), ...loaded.split('\n')]
      .filter(line => line.trim()).map(line => line.trim().split(/\s+/)[0]));
    for (const name of names) {
      if (masked.has(name) && !activeNames.has(name)) continue;
      if (!/^[A-Za-z0-9_.@:\\-]+\.service$/.test(name))
        throw new Error('unclassified service');
      const text = name.includes('@.') ? (await run(['cat', '--', name]))
        .split('\n').filter(line => /^(?:Exec|WorkingDirectory=|RootDirectory=)/.test(
          line.trim()) || /^(?:RootImage|EnvironmentFile|BindPaths|BindReadOnlyPaths)=/
          .test(line.trim()))
        .join('\n') : await run(['show',
          '--property=ExecCondition,ExecStart,ExecStartPre,ExecStartPost,' +
            'ExecStop,ExecStopPost,' +
            'ExecReload,WorkingDirectory,RootDirectory,RootImage,FragmentPath,' +
            'DropInPaths,SourcePath,EnvironmentFiles,BindPaths,BindReadOnlyPaths,' +
            'ReadWritePaths,ReadOnlyPaths,InaccessiblePaths,ExecSearchPath',
          '--', name]);
      const root = /^RootDirectory=(\/[^\n]+)$/m.exec(text)?.[1];
      // Unexpanded environment input cannot establish source non-use.
      if (/\$(?:[A-Za-z_]|\{)/.test(text))
        return { used: true, reason: 'PACKAGE_SERVICE_VISIBILITY_INCOMPLETE' };
      // Effective properties exclude comments and overridden unit commands.
      // Tokenize paths only; no arbitrary user-file or environment traversal.
      for (const match of text.matchAll(/\/[^\s"';={}]+/g)) {
        const path = match[0].replace(/\\x([a-fA-F0-9]{2})/g,
          (_, value) => String.fromCharCode(parseInt(value, 16)));
        const prefix = path.split('%')[0];
        if (path.includes('%') && (candidate.startsWith(prefix) ||
          withinPackage(prefix, candidate)))
          return { used: true, reason: 'PACKAGE_SERVICE_VISIBILITY_INCOMPLETE' };
        if (withinPackage(path, candidate) || (root &&
          withinPackage(resolve(root, '.' + path), candidate)))
          return { used: true, reason: 'PACKAGE_SERVICE_REFERENCE' };
        try {
          if (withinPackage(await canonical(path), candidate))
            return { used: true, reason: 'PACKAGE_SERVICE_REFERENCE' };
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        }
      }
    }
    return { used: false };
  } catch { return { used: true, reason: 'PACKAGE_SERVICE_VISIBILITY_INCOMPLETE' }; }
}
