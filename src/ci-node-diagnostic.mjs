// CI log contents are untrusted even after the job's identity is verified.
const errorClasses = new Set([
  'Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError',
  'URIError', 'EvalError', 'AssertionError', 'AggregateError',
]);
const errorLabels = new Set([...errorClasses, 'ERR_ASSERTION']);
const recordLimit = 8;
const frameLimit = 4;

function repositoryLocation(value, repository) {
  const name = repository?.split('/').at(-1);
  const root = name && /^[\w.-]+$/.test(name)
    ? `/home/runner/work/${name}/${name}/` : null;
  if (value.startsWith('file://')) {
    if (!value.startsWith('file:///')) return null;
    value = value.slice(7);
  }
  if (value.startsWith('/')) {
    if (!root || !value.startsWith(root)) return null;
    value = value.slice(root.length);
  }
  if (value.length > 180) return null;
  const match = /^((?:src|scripts|test)\/[\w./-]+\.[cm]?[jt]s):(\d{1,6}):(\d{1,6})$/
    .exec(value);
  if (!match || !Number(match[2]) || !Number(match[3])) return null;
  if (match[1].split('/').some(part => !part || part === '.' || part === '..'))
    return null;
  return `${match[1]}:${Number(match[2])}:${Number(match[3])}`;
}

export function nodeDiagnosticCollector(repository) {
  const tests = [];
  let current, count;
  return {
    observe(message) {
      const total = /^(?:ℹ|#) fail ([1-9]\d{0,5})$/.exec(message);
      if (total) count = Number(total[1]);
      const record = /^test at (.+)$/.exec(message);
      if (record) {
        current = null;
        if (tests.length >= recordLimit) return;
        current = {};
        tests.push(current);
        const location = repositoryLocation(record[1], repository);
        if (location) current.location = location;
        return;
      }
      // Successful tests and reporter metadata terminate the preceding record.
      if (/^(?:[✔ℹ#]|ok\s|not ok\s|✖ failing tests:)/.test(message)) current = null;
      if (!current) return;
      const error = /^([A-Za-z]+)(?: \[([A-Za-z_]+)\])?:/.exec(message);
      if (error && errorClasses.has(error[1]) &&
        (!error[2] || errorLabels.has(error[2]))) current.error = error[1];
      // A stack frame belongs only to a recognized failure with a supported class.
      if (!current.error || !message.startsWith('at ')) return;
      const frame = /^at (?:[^()\r\n]+ \(([^()]+)\)|([^()\s]+))$/.exec(message);
      if (!frame) return;
      const location = repositoryLocation(frame[1] ?? frame[2], repository);
      if (!location) return;
      const frames = current.frames ??= [];
      if (frames.length < frameLimit && !frames.includes(location)) frames.push(location);
    },
    diagnostic() {
      const retained = tests.filter(test => Object.keys(test).length);
      if (!retained.length && !count) return null;
      return { kind: 'node-test-failures', ...(count ? { count } : {}),
        tests: retained };
    },
  };
}

export function nodeCorrectionFindings(diagnostic) {
  const findings = [];
  if (diagnostic.count) findings.push(`Node reported ${diagnostic.count} failed tests.`);
  for (const test of diagnostic.tests) {
    findings.push('Node test failed' + (test.location ? ` at ${test.location}` : '') +
      (test.error ? ` with ${test.error}.` : '.'));
    for (const frame of test.frames ?? []) findings.push(`Node stack frame at ${frame}.`);
  }
  return findings;
}
