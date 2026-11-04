const gitModes = new Set(['100644', '100755']);

export const isSourceMode = (value) => gitModes.has(value);

// The pinned manifest authenticates Git mode on every OS. Node on Windows
// cannot round-trip POSIX execute bits; a source cache is not host adoption.
// POSIX execution backends still require the observed executable class.
export function matchesSourceMode(observed, declared) {
  return (
    isSourceMode(observed) &&
    isSourceMode(declared) &&
    (process.platform === 'win32' || observed === declared)
  );
}
