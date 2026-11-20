const init = '/sbin/init:';
const python = '/usr/bin/python3: ';
const issues = {
  JOB_VM_GUEST_PYTHON_UNAVAILABLE: [
    python + 'not found', python + 'No such file or directory',
    python + 'Permission denied', python + 'Exec format error',
  ],
  JOB_VM_GUEST_INIT_UNAVAILABLE: [
    'Kernel panic - not syncing: No working init found.',
    'Failed to execute /sbin/init (error -2)',
    'Failed to execute /sbin/init (error -8)',
  ],
};
const pythonCode = 'JOB_VM_GUEST_PYTHON_UNAVAILABLE';
const initCode = 'JOB_VM_GUEST_INIT_UNAVAILABLE';
const tailSize = Math.max(...Object.values(issues).flat().map(value => value.length));

// The dedicated readiness guest contains no model or project output. Match
// fixed kernel/shell diagnostics and discard all bytes beyond the known phrase
// widths, even when a diagnostic is split across stream chunks.
export function jobVmReadinessConsole() {
  const streams = new Map();
  let code;
  return {
    observe(stream, bytes) {
      let state = streams.get(stream) ?? { prefix: '', tail: '' };
      const lines = bytes.toString('latin1').split('\n');
      for (const [index, line] of lines.entries()) {
        if (index > 0) state = { prefix: '', tail: '' };
        state.prefix = (state.prefix + line).slice(0, init.length);
        const text = state.tail + line;
        if (state.prefix === init &&
          issues[pythonCode].some(marker => text.includes(marker)))
          code = pythonCode;
        else if (!code && issues[initCode].some(marker => text.includes(marker)))
          code = initCode;
        state.tail = text.slice(-tailSize);
      }
      streams.set(stream, state);
    },
    failure(error) {
      if (!code || (error.code !== 'JOB_VM_EXITED_BEFORE_HANDOFF' &&
        error.name !== 'TimeoutError')) return error;
      return Object.assign(new Error(code, { cause: error }), { code });
    },
  };
}
