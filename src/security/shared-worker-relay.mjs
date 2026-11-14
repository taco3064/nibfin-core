import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { requireThat } from '../identity.mjs';
import { readWorkerFrame } from './shared-worker-frame.mjs';

const pipeNumber = value => typeof value === 'string' && /^[1-9]\d*$/.test(value)
  ? Number(value) : NaN;

// The gate receives the same descriptors the Listener normally gives Worker.
// Start Worker only after admission and relay the unmodified cancellation data.
export async function relaySharedWorker(args, executable, admit) {
  const [command, sourcePipe, replyPipe] = args;
  const input = pipeNumber(sourcePipe);
  const output = pipeNumber(replyPipe);
  requireThat(process.platform === 'linux' && args.length === 3 &&
    command === 'spawnclient' && Number.isSafeInteger(input) && input > 2 &&
    Number.isSafeInteger(output) && output > 2 && input !== output,
  'SHARED_WORKER_PIPE_INVALID');

  // Opening the proc descriptor gives Node a FileHandle for exact reads.
  const source = await open(`/proc/self/fd/${input}`, 'r');
  let frame;
  try {
    frame = await readWorkerFrame(source);
  } finally {
    await source.close();
  }
  await admit(frame.message);
  return relay(input, output, executable, frame);
}

async function relay(input, output, executable, { header, body }) {
  const transfer = new Socket({ fd: input, readable: true, writable: false });
  const child = spawn(executable, ['spawnclient', '3', '4'], {
    stdio: ['ignore', 'inherit', 'inherit', 'pipe', output],
  });
  const channel = child.stdio[3];
  const signals = new Map(['SIGINT', 'SIGTERM', 'SIGHUP']
    .map(signal => [signal, () => child.kill(signal)]));
  for (const [signal, forward] of signals) process.on(signal, forward);

  try {
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
    const transferred = finished(channel);
    const frames = Readable.from((async function* () {
      yield header;
      yield body;
      yield* transfer;
    })());
    frames.on('error', error => channel.destroy(error));
    frames.pipe(channel);
    const failed = transferred.then(() => exited, error => {
      if (error.code === 'EPIPE' || error.code === 'ERR_STREAM_PREMATURE_CLOSE')
        return exited;
      throw error;
    });
    return await Promise.race([exited, failed]);
  } finally {
    for (const [signal, forward] of signals) process.off(signal, forward);
    transfer.destroy();
    channel.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
