import { constants, readFileSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { isId, requireThat } from './identity.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export const hostMemoryPressure = 'HOST_MEMORY_PRESSURE_CONFIRMED';
export const pressureStages = new Set([
  'shape', 'validate-shape', 'deliver', 'accept', 'review-pr',
]);

// Only StageRuntime produces this compact marker after private proof validation.
export function retryableHostPressure(result, stage = result?.stage) {
  return result?.status === 'denied' && result.code === hostMemoryPressure &&
    result.pressureConfirmed === true && pressureStages.has(stage);
}

export function pressureBinding(stage, context) {
  const execution = context.execution;
  return { stage, runnerId: context.runner?.runnerId, executionId: execution.id,
    runId: execution.runId, attempt: execution.attempt, jobId: execution.jobId };
}

function validBinding(value) {
  return value && pressureStages.has(value.stage) &&
    typeof value.executionId === 'string' &&
    uuid.test(value.executionId) &&
    ['runnerId', 'runId', 'attempt', 'jobId'].every(key => isId(value[key]));
}

// This validates private Controller evidence, never Agent output or public prose.
export function confirmedHostPressure(value, expected = value?.binding) {
  return validBinding(value?.binding) && value.schemaVersion === 1 &&
    value.code === hostMemoryPressure &&
    ['stage', 'runnerId', 'executionId', 'runId', 'attempt', 'jobId']
      .every(key => value.binding[key] === expected?.[key]) &&
    uuid.test(value.bootId) &&
    Number.isFinite(value.startedAt) && value.startedAt >= 0 &&
    Number.isFinite(value.observedAt) && value.observedAt >= value.startedAt &&
    value.endedAt >= value.observedAt &&
    Number.isFinite(value.endedAt) && isId(value.victimPid) &&
    /^[1-9][0-9]*$/.test(value.startTicks) &&
    Number.isSafeInteger(value.sequence) && value.sequence >= 0;
}

export function pressureMatchesReceipt(value, stage, execution) {
  if (!confirmedHostPressure(value)) return false;
  const expected = { ...value.binding, stage, executionId: execution?.id,
    runId: execution?.runId, attempt: execution?.attempt, jobId: execution?.jobId };
  return confirmedHostPressure(value, expected);
}

export function processIdentityNow(pid) {
  if (!isId(pid)) return null;
  try {
    return parseIdentity(pid, readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch { return null; }
}

function parseIdentity(pid, stat) {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const startTicks = fields[19];
  return /^[1-9][0-9]*$/.test(startTicks) ? { pid, startTicks } : null;
}

export async function processIdentity(pid) {
  if (!isId(pid)) return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return parseIdentity(pid, stat);
  } catch { return null; }
}

// Fail closed: only an absent /proc entry proves that no process has this PID.
// Unreadable or unparsable process state is never evidence of termination.
export async function observedProcessIdentity(pid, read = readFile) {
  requireThat(isId(pid), 'PROCESS_IDENTITY_UNAVAILABLE');
  let stat;
  try { stat = await read(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const identity = typeof stat === 'string' ? parseIdentity(pid, stat) : null;
  requireThat(identity, 'PROCESS_IDENTITY_UNAVAILABLE');
  return identity;
}

async function uptime() {
  return Number((await readFile('/proc/uptime', 'utf8')).split(' ')[0]);
}

// Nonblocking and bounded: a noisy or overrun ring is unavailable evidence.
// Unrelated records are discarded immediately, including during initial draining.
export async function kernelReader() {
  const file = await open('/dev/kmsg', constants.O_RDONLY | constants.O_NONBLOCK);
  return {
    async read() {
      const records = [];
      for (let count = 0; count < 256; count++) {
        const buffer = Buffer.alloc(8192);
        try {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
          if (!bytesRead) return records;
          records.push(buffer.subarray(0, bytesRead).toString('utf8'));
        } catch (error) {
          if (error.code === 'EAGAIN') return records;
          throw error;
        }
      }
      throw new Error('KERNEL_OBSERVATION_OVERFLOW');
    },
    close: () => file.close(),
  };
}

function kernelRecord(text) {
  const match = /^(\d+),(\d+),(\d+),-;([^\n]+)\n?$/.exec(text);
  if (!match) return null;
  return { priority: Number(match[1]), sequence: Number(match[2]),
    time: Number(match[3]) / 1e6, message: match[4] };
}

function globalVictim(record) {
  // Only the kernel facility and an explicit global, unconstrained OOM qualify.
  // A memcg/container OOM, killed-process line or exit signal alone cannot qualify.
  if (record.priority >= 8) return null;
  const match = /^oom-kill:constraint=CONSTRAINT_NONE,nodemask=\(null\),/.test(
    record.message) && /,global_oom,task_memcg=[^,]+,task=[^,]+,pid=(\d+),uid=\d+$/.exec(
    record.message);
  return match ? Number(match[1]) : null;
}

// The adapter starts this before launch and supplies only identities it owns.
// Confirmation additionally requires the same process to still exist when the
// record is read. This deliberately misses fast exits instead of guessing across
// PID reuse. No raw kernel messages escape this module.
export async function observeHostPressure(binding, {
  reader = kernelReader, identity = processIdentity, clock = uptime,
  boot = () => readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
  interval = 20,
} = {}) {
  let source, timer, pending = Promise.resolve(), unavailable = false;
  let sequence, observation, reading = false, stopping = false;
  const owned = new Map();
  let bootId;
  const discard = async () => {
    unavailable = true;
    observation = undefined;
    clearInterval(timer);
  };
  const drain = async (initial = false) => {
    try {
      for (const text of await source.read()) {
        const record = kernelRecord(text);
        if (!record || !Number.isSafeInteger(record.sequence) ||
          sequence !== undefined && record.sequence !== sequence + 1) {
          await discard();
          return;
        }
        sequence = record.sequence;
        if (initial) continue;
        const victim = globalVictim(record), owner = owned.get(victim);
        if (!owner || record.time < owner.capturedAt) continue;
        const live = await identity(victim);
        const now = await clock();
        if (live?.startTicks !== owner.startTicks || record.time > now) continue;
        observation = { schemaVersion: 1, code: hostMemoryPressure,
          binding: structuredClone(binding), bootId, startedAt: owner.capturedAt,
          observedAt: record.time, endedAt: now, victimPid: victim,
          startTicks: owner.startTicks, sequence: record.sequence };
      }
    } catch { await discard(); }
  };
  try {
    if (!validBinding(binding)) throw new Error('INVALID_PRESSURE_BINDING');
    binding = structuredClone(binding);
    bootId = (await boot()).trim();
    source = await reader();
    await drain(true);
    if (!unavailable) {
      timer = setInterval(() => {
        if (reading || unavailable || stopping) return;
        reading = true;
        pending = drain().finally(() => { reading = false; });
      }, interval);
      timer.unref();
    }
  } catch { await discard(); }
  return {
    get active() { return !unavailable && !stopping; },
    async own(pid, startTicks) {
      if (unavailable || stopping) return;
      try {
        const process = await identity(pid);
        // /proc/uptime has centisecond resolution. Exclude that whole tick.
        const capturedAt = await clock() + 0.01;
        if (!owned.has(pid) && owned.size >= 256)
          owned.delete(owned.keys().next().value);
        if (process && (!startTicks || process.startTicks === startTicks) &&
          owned.get(pid)?.startTicks !== process.startTicks)
          owned.set(pid, { ...process, capturedAt });
      } catch { await discard(); }
    },
    async finish() {
      stopping = true;
      clearInterval(timer);
      await pending;
      if (!unavailable) await drain();
      try { await source?.close(); } catch { await discard(); }
      return !unavailable && confirmedHostPressure(observation, binding)
        ? observation : undefined;
    },
  };
}
