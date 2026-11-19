const kinds = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError',
  'URIError', 'EvalError', 'AggregateError',
]);

// Error messages and command arguments may contain credentials. Retain only
// standard exception kinds and locations inside the maintained Core source.
export function commandDiagnostic(error, root = new URL('../', import.meta.url)) {
  const source = root.href;
  const frames = [];
  for (const line of String(error?.stack ?? '').split('\n').slice(1)) {
    const offset = line.indexOf(source);
    if (offset < 0) continue;
    const location = line.slice(offset + source.length).trim();
    const match = location.match(
      /^((?:src|bin)\/[A-Za-z0-9_./-]+\.mjs):([0-9]+):([0-9]+)\)?$/,
    );
    if (match && !match[1].split('/').includes('..')) {
      frames.push({ file: match[1], line: Number(match[2]), column: Number(match[3]) });
    }
  }
  return { kind: kinds.has(error?.name) ? error.name : 'Error', frames };
}
