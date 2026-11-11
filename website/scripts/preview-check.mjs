import { inspectLandingOutput } from './landing-output.mjs';
import { inspectDeliveryOutput } from './delivery-output.mjs';
import { checkArticleLinks } from './article-links.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectOutput, english } from './output.mjs';
import { inspectThemeOutput } from './theme-output.mjs';
import { processGroupAbsent } from './process.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
async function build(env) {
  const child = spawn(npm, ['run', 'website:build'], { env, stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve()
      : reject(new Error(`Website build failed: ${code}`)));
  });
}

async function verify(base, port) {
  const env = { ...process.env, WEBSITE_BASE: base,
    WEBSITE_SITE: 'https://example.org' };
  await build(env);
  await inspectDeliveryOutput(base);
  await inspectLandingOutput(base);
  await checkArticleLinks(base);
  const assets = [...await inspectOutput(base), ...await inspectThemeOutput(base)];
  if (process.env.CI !== 'true' || process.argv.includes('--static')) {
    console.log(`Static paths passed: ${base}; HTTP remains Unverified.`);
    return;
  }
  // Launch the documented preview command; a process group includes npm's children.
  const child = spawn(npm, ['run', 'website:preview', '--',
    '--host', '127.0.0.1', '--port', String(port)],
  { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      process.stdout.write(chunk);
      output = (output + chunk).slice(-65536);
    });
  }
  let ended = false;
  let launchError;
  const closed = new Promise((resolve) => {
    child.once('error', (error) => { launchError = error; ended = true; resolve(); });
    child.once('exit', () => { ended = true; });
    child.once('close', resolve);
  });
  const origin = `http://127.0.0.1:${port}`;
  const request = (path) => fetch(`${origin}${path}`, {
    redirect: 'error', signal: AbortSignal.timeout(3000),
  });
  try {
    let index;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      assert(!ended, `Preview exited before readiness: ${launchError || ''}`);
      // Astro may choose another port if occupied. Require our own process to
      // announce the requested URL before trusting a response from that port.
      if (!output.includes(`${origin}/`)) {
        await delay(200);
        continue;
      }
      try {
        index = await request(base);
        break;
      } catch {
        await delay(200);
      }
    }
    assert(index, 'Preview startup timed out');
    assert.equal(index.status, 200);
    assert((await index.text()).includes(english), 'Wrong index response');
    const missing = await request(`${base}does-not-exist-doc01/`);
    assert.equal(missing.status, 404, 'Missing route must return 404');
    assert(!(await missing.text()).includes(english), 'Index fallback on missing route');
    for (const path of assets) {
      const response = await request(path);
      assert.equal(response.status, 200, `Asset request failed: ${path}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert(bytes.length > 20, `Empty resource: ${path}`);
      const expected = await readFile(join('website/dist', path.slice(base.length)));
      assert(Buffer.from(bytes).equals(expected), `Wrong resource content: ${path}`);
      const text = new TextDecoder().decode(bytes);
      assert(!/^\s*(?:<!doctype|<html)/i.test(text), `HTML asset fallback: ${path}`);
      const type = response.headers.get('content-type') || '';
      if (path.endsWith('.css')) assert(type.includes('text/css'), path);
      if (/\.m?js$/.test(path)) assert(/javascript/.test(type), path);
    }
    assert(!ended, 'Preview exited during checks');
    console.log(`HTTP index, 404, CSS, JavaScript and search passed: ${base}`);
  } finally {
    if (child.pid) {
      const signal = (name) => {
        try { process.kill(-child.pid, name); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      };
      // Also stop descendants if npm itself has already exited unexpectedly.
      signal('SIGTERM');
      let streamsClosed = false;
      void closed.then(() => { streamsClosed = true; });
      const waitForStop = async (milliseconds) => {
        const deadline = Date.now() + milliseconds;
        while (Date.now() < deadline) {
          if (streamsClosed && processGroupAbsent(child.pid)) return true;
          await delay(50);
        }
        return false;
      };
      if (!(await waitForStop(5000))) {
        signal('SIGKILL');
        const stopped = await waitForStop(2000);
        assert(stopped, 'Preview process-group termination unverified');
        throw new Error('Preview cleanup timed out');
      }
    }
  }
}

await verify('/nibfin-core/', 4321);
await verify('/alternate-docs/', 4322);
