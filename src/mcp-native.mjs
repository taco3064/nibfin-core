import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { prepareWindowsMcpReader } from './mcp-windows.mjs';
import { requireThat, sha256 } from './identity.mjs';

// This reads configuration, not an Agent turn. No model or MCP tool is called.
// Native config/read preserves policies omitted by `codex mcp get --json`.
export async function readNativeMcpConfiguration(
  executable, { cwd, env, timeout = 15000 },
) {
  const windows = process.platform === 'win32';
  const reader = windows ? await prepareWindowsMcpReader() : null;
  let cleanupSafe = false;
  try {
    if (reader) requireThat(sha256(await readFile(reader.executable)) === reader.hash,
      'WINDOWS_MCP_READER_CHANGED');
    return await runNativeReader(executable, { cwd, env, timeout }, reader,
      proved => { cleanupSafe = proved; });
  } catch (error) {
    if (reader && !cleanupSafe) error.recoveryDirectory = reader.root;
    throw error;
  } finally {
    if (reader && cleanupSafe) await reader.release();
  }
}

function runNativeReader(executable, { cwd, env, timeout }, reader, terminated) {
  const windows = process.platform === 'win32';
  return new Promise((resolveResult, reject) => {
    const child = spawn(reader?.executable ?? executable,
    windows ? [executable, cwd] :
      ['app-server', '--stdio'], {
      cwd, env: windows ? { SystemRoot: 'C:/Windows', TEMP: tmpdir(), TMP: tmpdir(),
        ...env } : env, shell: false, windowsHide: true,
      detached: process.platform === 'linux', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const decoder = new StringDecoder('utf8');
    const decoderError = new StringDecoder('utf8');
    let buffer = '', result, failure, size = 0, exited = false, settled = false;
    let requested = false, windowsProof = false, errorBuffer = '', windowsProcess;
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
      if (windows) child.stdin.end();
      else stop();
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
      if (settled) return;
      errorBuffer = (errorBuffer + decoderError.write(bytes)).slice(-4096);
      if (errorBuffer.split(/\r?\n/).includes('NIBFIN_WINDOWS_MCP_TERMINATED'))
        windowsProof = true;
      const identity = /NIBFIN_WINDOWS_MCP_PROCESS (\d+) (\d+)/.exec(errorBuffer);
      if (identity) windowsProcess = {
        pid: Number(identity[1]), creationFileTime: identity[2],
      };
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
          if (!windows) stop();
        }
      }
    });
    child.on('error', () => fail('USER_CODEX_UNAVAILABLE'));
    child.on('exit', () => { exited = true; });
    child.on('close', code => {
      terminated(windowsProof && code === 0);
      if (windows && (!windowsProof || code !== 0)) failure = Object.assign(
        new Error('USER_MCP_CONFIG_TERMINATION_UNKNOWN'),
        { code: 'USER_MCP_CONFIG_TERMINATION_UNKNOWN', originalCode: failure?.code,
          windowsProcess },
      );
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
