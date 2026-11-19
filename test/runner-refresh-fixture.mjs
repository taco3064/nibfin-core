import assert from 'node:assert/strict';

export const artifact = { name: 'actions-runner-linux-x64-9.99.0.tar.gz',
  url: 'https://github.com/actions/runner/releases/download/v9.99.0/' +
    'actions-runner-linux-x64-9.99.0.tar.gz', sha256: 'a'.repeat(64) };
export const selected = { arch: 'amd64', artifact, release: { tag_name: 'v9.99.0' } };
export const failure = code => Object.assign(new Error(code), { code });

export function fixture() {
  let state = null, admission = null, workspaces = 0;
  const calls = [], running = [true, false], installed = new Set();
  const binding = { pool: { runners: [{ id: 1 }, { id: 2 }] } };
  const ports = {
    inspect: async () => {}, external: async () => {}, binding: async () => binding,
    read: async () => structuredClone(state ?? admission),
    write: async value => { calls.push('write'); state = structuredClone(value); },
    discover: async () => selected,
    current: async () => installed.size === 2,
    settle: async () => { calls.push('settle'); },
    running: async () => [...running],
    workspace: async () => ({ path: `/private/operation-${++workspaces}` }),
    prepare: async () => { calls.push('prepare'); },
    close: async value => { calls.push('close');
      admission = structuredClone({ ...value, phase: 'draining' }); },
    closed: async () => { calls.push('closed'); },
    stopped: async slot => !running[slot - 1],
    stop: async slot => { calls.push(`stop${slot}`); running[slot - 1] = false; },
    install: async slot => { calls.push(`install${slot}`); installed.add(slot); },
    verify: async () => assert.equal(installed.size, 2),
    release: async () => { calls.push('release'); admission = null; },
    started: async slot => running[slot - 1],
    start: async slot => { calls.push(`start${slot}`); running[slot - 1] = true; },
    cleanup: async () => { calls.push('cleanup'); },
  };
  return { ports, calls, running, installed,
    state: () => state, forget: () => { state = null; } };
}
