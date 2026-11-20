import test from 'node:test';
import assert from 'node:assert/strict';
import { runJobVmReadiness, verifyGuestReadiness } from '../src/job-vm-readiness.mjs';
import { requireJobVmToolOutput } from '../src/job-vm-workspace.mjs';

const root = '.nibfin-cache/6c603253-dca6-0a82-5df0-f70727526963';
const directories = [root + '/home', root + '/tmp'];
const ready = { ready: true, toolOutput: {
  root, directories, collection: 'preserve-source-omit-owned-output',
} };

test('the #277/#564 old guest ready response cannot start a Writer', () => {
  for (const reply of [{ ready: true }, { ...ready, toolOutput: {
    ...ready.toolOutput, directories: [root + '/home'],
  } }, { ...ready, toolOutput: { ...ready.toolOutput, root: 'different-output' } }]) {
    assert.throws(() => requireJobVmToolOutput(reply, root, directories),
      { code: 'JOB_VM_TOOL_OUTPUT_UNAVAILABLE' });
  }
});

test('runtime maintenance can satisfy the same request without a version gate', () => {
  requireJobVmToolOutput(ready, root, directories);
  requireJobVmToolOutput({ ...ready, toolOutput: {
    ...ready.toolOutput, directories: [...directories].reverse(),
  } }, root, directories);
});

function fixture(projection = files => files) {
  const calls = [];
  let source;
  let scratch;
  const ports = {
    workspace: () => ({
      prepare: async (name, files, options) => {
        calls.push(name);
        if (name !== 'work') {
          assert.deepEqual(files, []);
          return;
        }
        assert.equal(files.length, 1);
        source = structuredClone(files);
        assert.match(options.root, /^\.nibfin-cache\//);
        assert.ok(options.directories.every(path => path.startsWith(options.root + '/')));
        scratch = { path: options.root + '/readiness-output',
          executable: false, content: Buffer.from('tool output').toString('base64') };
      },
      exercise: async () => { calls.push('exercise'); },
      collect: async () => {
        calls.push('collect');
        return projection(source, scratch);
      },
    }),
    openRelay: async () => {
      calls.push('open');
      return async () => calls.push('close');
    },
    probe: async () => { calls.push('probe'); },
  };
  return { calls, ports };
}

test('model-free readiness exercises initialized guest effects and collects source',
  async () => {
    const { calls, ports } = fixture();
    await verifyGuestReadiness(null, '/private/guest', new AbortController().signal,
      ports);
    assert.deepEqual(calls, ['work', 'main', 'input', 'exercise', 'open', 'probe',
      'close', 'collect']);
  });

test('guest readiness rejects lost source and returned disposable tool output',
  async () => {
    for (const projection of [() => [], (files, scratch) => [...files, scratch]]) {
      const { ports } = fixture(projection);
      await assert.rejects(
        verifyGuestReadiness(null, '/private/guest', new AbortController().signal,
          ports), { code: 'JOB_VM_READINESS_CONTENT_CHANGED' });
    }
  });

test('private boot diagnostics distinguish unsupported Python and init', async () => {
  for (const [lines, code] of [
    [['/sbin/ini', 't: 29: exec: /usr/bin/py', 'thon3: not found\r\n'],
      'JOB_VM_GUEST_PYTHON_UNAVAILABLE'],
    [['[    7.019] Failed to execute /sbin/init (error -2)\n'],
      'JOB_VM_GUEST_INIT_UNAVAILABLE'],
  ]) {
    let released = false;
    const failure = Object.assign(new Error('guest stopped'), {
      code: 'JOB_VM_EXITED_BEFORE_HANDOFF',
    });
    await assert.rejects(runJobVmReadiness({}, Buffer.from('executor'), {
      async capacity() { return () => { released = true; }; },
      async runVm(_config, { observeConsole }) {
        for (const text of lines) observeConsole('stdout', Buffer.from(text));
        throw failure;
      },
    }), error => error.code === code && error.cause === failure &&
      !error.message.includes(lines.at(-1)));
    assert.equal(released, true);
  }
});

test('unknown guest exit and Writer capacity observations remain unchanged', async () => {
  const boot = Object.assign(new Error('guest stopped'), {
    code: 'JOB_VM_EXITED_BEFORE_HANDOFF',
  });
  const pressure = Object.assign(new Error('pressure'), {
    code: 'JOB_VM_HOST_MEMORY_PRESSURE',
  });
  await assert.rejects(runJobVmReadiness({}, Buffer.from('executor'), {
    async capacity() { return () => {}; },
    async runVm(_config, { observeConsole }) {
      observeConsole('stdout', Buffer.from('normal kernel output, Python not found'));
      throw boot;
    },
  }), error => error === boot);
  await assert.rejects(runJobVmReadiness({}, Buffer.from('executor'), {
    async capacity() { throw pressure; },
    runVm: () => assert.fail('No guest boot after Writer capacity refuses'),
  }), error => error === pressure);
});
