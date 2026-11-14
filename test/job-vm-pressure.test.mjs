import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireWriterCapacity, writerCapacity, writerPressureWait }
  from '../src/job-vm-pressure.mjs';

const sample = (available, stalls = 0, blocks = 2) => writerCapacity(
  `MemAvailable: ${available * 1024} kB\n`, `full avg10=${stalls}\n`,
  `Node 0, zone DMA32 10 2 3 4 5 6 7 ${blocks} 0\n`, 640,
);

test('WSL capacity keeps healthy concurrency and distinguishes pressure and fragmentation', () => {
  assert.equal(sample(2600).mode, 'parallel');
  assert.equal(sample(1300).mode, 'serial');
  assert.equal(sample(2600, 0, 0).mode, 'serial');
  assert.equal(sample(2600, 1.2).mode, 'serial');
  assert.equal(sample(800).mode, 'wait');
  assert.equal(sample(2600, 5).mode, 'wait');
});

test('shared Writer state allows healthy overlap and drains before serial admission',
  { skip: process.platform !== 'linux' }, async () => {
    const pressureRoot = await mkdtemp(join(tmpdir(), 'nibfin-pressure-'));
    const config = { pressureRoot, memoryMiB: 640 };
    const signal = new AbortController().signal;
    const enter = (metrics, options) => acquireWriterCapacity(config, signal, {
      read: async () => metrics, report: () => {}, ...options,
    });
    const releases = [];
    try {
      const first = await enter(sample(2600));
      releases.push(first, await enter(sample(2600)));
      let waits = 0;
      const exclusive = await enter(sample(1300), { wait: async () => {
        await releases.shift()();
        waits++;
      } });
      releases.push(exclusive);
      assert.equal(waits, 2);
      let now = 0;
      await assert.rejects(enter(sample(800), {
        clock: () => now, wait: async ms => { now += ms; },
      }), { code: writerPressureWait });
      assert.equal(now, 300_000);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(acquireWriterCapacity(config, controller.signal, {
        read: async () => sample(2600),
      }), { name: 'AbortError' });
    } finally {
      await Promise.all(releases.map(release => release()));
      await rm(pressureRoot, { recursive: true, force: true });
    }
  });
