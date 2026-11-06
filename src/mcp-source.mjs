import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { command } from './process.mjs';
import { requireThat, digest } from './identity.mjs';
import { inheritUserMcp, disabledMcpServer } from './mcp-profile.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { restrictMcpToReadOnly } from './mcp-catalog.mjs';
import { guardedMcpDiscovery } from './mcp-discovery.mjs';

// This reads configuration, not an Agent turn. No model or MCP tool is called.
// Native config/read preserves policies omitted by `codex mcp get --json`.
export function readNativeMcpConfiguration(executable, { cwd, env, timeout = 15000 }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, ['app-server', '--stdio'], {
      cwd, env, shell: false, windowsHide: true,
      detached: process.platform === 'linux', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const decoder = new StringDecoder('utf8');
    let buffer = '', result, failure, size = 0, exited = false, settled = false;
    let requested = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
      child.unref();
      if (failure || !result) reject(failure ??
        Object.assign(new Error('USER_MCP_CONFIG_UNAVAILABLE'), {
          code: 'USER_MCP_CONFIG_UNAVAILABLE',
        }));
      else resolveResult(result);
    };
    const fail = code => {
      failure ??= Object.assign(new Error(code), { code });
      stop();
    };
    const stop = () => {
      if (exited) return;
      try {
        if (process.platform === 'linux') process.kill(-child.pid, 'SIGTERM');
        else child.kill();
      } catch { /* close/timeout determines whether termination was proved. */ }
    };
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    const timer = setTimeout(() => fail('USER_MCP_CONFIG_TIMEOUT'), timeout);
    const hardTimer = setTimeout(() => {
      if (!exited) {
        try {
          if (process.platform === 'linux') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* Preserve failure without claiming clean termination. */ }
      }
      failure ??= Object.assign(new Error('USER_MCP_CONFIG_TERMINATION_UNKNOWN'), {
        code: 'USER_MCP_CONFIG_TERMINATION_UNKNOWN',
      });
      finish();
    }, timeout + 1000);
    child.stdin.on('error', () => {});
    child.stderr.on('data', bytes => {
      size += bytes.length;
      if (size > 2 * 1024 * 1024) fail('USER_MCP_CONFIG_TOO_LARGE');
    });
    child.stdout.on('data', bytes => {
      size += bytes.length;
      if (size > 2 * 1024 * 1024) return fail('USER_MCP_CONFIG_TOO_LARGE');
      if (settled || failure) return;
      buffer += decoder.write(bytes);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); }
        catch { return fail('INVALID_NATIVE_MCP_CONFIG_RESPONSE'); }
        if (message.id === 1) {
          if (message.error || requested)
            return fail('USER_MCP_CONFIG_INITIALIZATION_FAILED');
          requested = true;
          send({ method: 'initialized' });
          send({ id: 2, method: 'config/read', params: { includeLayers: true } });
        }
        if (message.id === 2) {
          if (!requested || result || message.error || !message.result?.config)
            return fail('USER_MCP_CONFIG_READ_FAILED');
          result = message.result;
          child.stdin.end();
          stop();
        }
      }
    });
    child.on('error', () => fail('USER_CODEX_UNAVAILABLE'));
    child.on('exit', () => { exited = true; });
    child.on('close', () => {
      if (child.pid && process.platform === 'linux') {
        let absent = false;
        try { process.kill(-child.pid, 0); }
        catch (error) { absent = error.code === 'ESRCH'; }
        if (!absent) failure = Object.assign(
          new Error('USER_MCP_CONFIG_TERMINATION_UNKNOWN'),
          { code: 'USER_MCP_CONFIG_TERMINATION_UNKNOWN',
            originalCode: failure?.code ?? null },
        );
      }
      finish();
    });
    send({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'nibfin_mcp_inheritance', version: '1' },
      capabilities: { experimentalApi: true },
    } });
  });
}

async function privateSource(path, uid, directory = false) {
  requireThat(isAbsolute(path) && resolve(path) === path &&
    await realpath(path) === path, 'UNTRUSTED_USER_MCP_SOURCE');
  const stat = await lstat(path);
  requireThat(stat.uid === uid && (stat.mode & 0o077) === 0 &&
    (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1),
  'UNTRUSTED_USER_MCP_SOURCE');
}

// source comes exclusively from administrator-owned host adoption. Resolve only
// the user's home, never the worktree or its project configuration/plug-in hooks.
export async function loadUserMcp(source, {
  environment = process.env, nativeRead = readNativeMcpConfiguration,
  run = command, validateExecutable = rootOwnedPath,
  restrict = restrictMcpToReadOnly, discoveryRoot,
} = {}) {
  if (source === undefined) return null;
  requireThat(process.platform === 'linux', 'UNSUPPORTED_USER_MCP_SOURCE_HOST');
  requireThat(source && Object.keys(source).sort().join(',') ===
    'codex,home,uid' && Number.isSafeInteger(source.uid) && source.uid > 0,
  'INVALID_USER_MCP_SOURCE');
  await validateExecutable(source.codex);
  await privateSource(source.home, source.uid, true);
  await privateSource(join(source.home, 'config.toml'), source.uid);
  const env = {
    ...environment, CODEX_HOME: source.home, HOME: dirname(source.home),
  };
  const version = (await run(source.codex, ['--version'], {
    cwd: source.home, env, timeout: 15000, limit: 1024,
  })).stdout.toString().trim();
  requireThat(/^codex-cli 0\.166\.0(?:-alpha\.\d+)?$/.test(version),
    'UNVERIFIED_USER_MCP_CLI_VERSION');
  const resolved = await nativeRead(source.codex, { cwd: source.home, env });
  requireThat(Array.isArray(resolved.layers) && resolved.layers.length > 0,
    'USER_MCP_PROVENANCE_UNAVAILABLE');
  for (const layer of resolved.layers) {
    requireThat(['system', 'user'].includes(layer.name?.type) &&
      !layer.name.profile && !layer.disabledReason,
    'USER_MCP_CONFIG_LAYER_UNSUPPORTED');
    if (layer.name.type === 'user')
      requireThat(layer.name.file === join(source.home, 'config.toml'),
        'USER_MCP_CONFIG_LAYER_UNSUPPORTED');
    else if (Object.keys(layer.config ?? {}).length)
      await validateExecutable(layer.name.file);
  }
  const config = resolved.config;
  const listed = await run(source.codex, ['mcp', 'list', '--json'], {
    cwd: source.home, env, timeout: 15000, limit: 2 * 1024 * 1024,
  });
  const inventory = JSON.parse(listed.stdout.toString());
  requireThat(Array.isArray(inventory), 'INVALID_USER_MCP_INVENTORY');
  let credentials = {};
  const path = join(source.home, '.credentials.json');
  try {
    await privateSource(path, source.uid);
    requireThat((await lstat(path)).size < 1024 * 1024,
      'USER_MCP_CREDENTIAL_STORE_TOO_LARGE');
    credentials = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const profile = inheritUserMcp(config.mcp_servers ?? {}, {
    environment, credentials,
  });
  profile.metadata.nativeVersion = version;
  for (const item of inventory) {
    if (item.enabled !== false && !Object.hasOwn(config.mcp_servers ?? {}, item.name))
      profile.metadata.diagnostics.push({
        name: item.name, code: 'USER_MCP_PLUGIN_CONFIGURATION_UNAVAILABLE',
      });
    const server = profile.configuration.mcp_servers[item.name];
    const fileAuth = Object.keys(server?.http_headers ?? {}).length > 0;
    const unavailable = item.auth_status === 'not_logged_in' && !fileAuth ?
      'USER_MCP_EXISTING_LOGIN_UNAVAILABLE' :
      item.auth_status === 'oauth' && !fileAuth ?
        'USER_MCP_NATIVE_KEYRING_UNAVAILABLE' : null;
    if (item.enabled !== false && server?.enabled !== false && unavailable) {
      profile.metadata.diagnostics.push({
        name: item.name, code: unavailable,
      });
      requireThat(server?.required !== true, 'REQUIRED_USER_MCP_UNAVAILABLE');
      if (server) profile.configuration.mcp_servers[item.name] = disabledMcpServer();
    }
  }
  await restrict(profile, guardedMcpDiscovery(discoveryRoot));
  profile.metadata.sourceHash = digest(resolved.layers.map(layer => ({
    name: layer.name, version: layer.version,
  })));
  profile.metadata.hosts = [...new Set(Object.values(
    profile.configuration.mcp_servers,
  ).filter(server => server.enabled !== false && server.url)
    .map(server => new URL(server.url).hostname))].sort();
  profile.policyHash = digest({ metadata: profile.metadata,
    servers: profile.configuration.mcp_servers });
  return profile;
}
