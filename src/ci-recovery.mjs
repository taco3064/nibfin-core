export const requiredCheckFailed = 'CI_REQUIRED_CHECK_FAILED';

const goToolErrors = [
  'UNTRUSTED_TOOL_PATH', 'TOOL_UNAVAILABLE', 'TEMP_DIRECTORY_UNAVAILABLE',
];
const goNilPointer = 'panic: runtime error: invalid memory address or nil pointer ' +
  'dereference';

function goTestFailure(message) {
  return /^--- FAIL: ((?:Test|Fuzz|Example)[\w/.-]{0,100}) \(\d+(?:\.\d+)?s\)$/
    .exec(message)?.[1];
}

function observeGoFailure(failure, message) {
  if (message === goNilPointer || message.startsWith(goNilPointer + ' [recovered'))
    failure.error = 'GO_NIL_POINTER';
  const assertion = /^([\w-]+_test\.go:\d{1,6}): (.*)$/.exec(message);
  if (!assertion) return;
  if (assertion[1].length <= 120) failure.location = assertion[1];
  const error = assertion[2].trimEnd().split(/\s+/).at(-1);
  if (goToolErrors.includes(error)) failure.error = error;
}

function failureDiagnostic(logs, step) {
  const start = Date.parse(step?.started_at);
  const end = Date.parse(step?.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
  let error, location;
  const goFailures = new Map();
  let goFailure;
  for (const line of logs.split('\n')) {
    const entry = /^(\S+) (.*)$/.exec(line);
    if (!entry) continue;
    const time = Date.parse(entry[1]);
    if (!Number.isFinite(time) || time < start || time >= end + 1000) continue;
    const message = entry[2].replace(/\x1b\[[0-9;]*m/g, '').trim();
    const name = goTestFailure(message);
    if (name) {
      goFailure = goFailures.get(name);
      if (!goFailure && goFailures.size < 8) {
        goFailure = { name };
        goFailures.set(name, goFailure);
      }
    } else if (goFailure) observeGoFailure(goFailure, message);
    const playwright = /^(?:Error: )?(?:ERROR: )?Playwright does not support /;
    const target = playwright.test(message) &&
      / (chromium-headless-shell|chromium|firefox|webkit) on (\S+)$/
      .exec(message);
    if (target && /^ubuntu\d{2}\.\d{2}-(?:x64|arm64)$/.test(target[2])) return {
      kind: 'playwright-unsupported-target',
      browser: target[1], platform: target[2] };
    const code = /^Error: ([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)$/.exec(message);
    if (code && code[1].length <= 80) {
      error = code[1];
      location = undefined;
    }
    if (!error) continue;
    const prefix = /^at .*?\(file:\/\/\/home\/runner\/work\/[^/]+\/[^/]+\//;
    if (!prefix.test(message)) continue;
    const frame = /^((?:src|scripts|test)\/[\w./-]{1,120}\.[cm]?[jt]s:\d{1,6}):\d+\)$/
      .exec(message.replace(prefix, ''));
    if (frame && !frame[1].includes('..')) location = frame[1];
  }
  if (goFailures.size)
    return { kind: 'go-test-failures', tests: [...goFailures.values()] };
  return error ? { kind: 'error-code', error, ...(location ? { location } : {}) } : null;
}

function cleanName(name) {
  return typeof name === 'string'
    ? name.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120) : '';
}

export function ciFailureResult(error, stage) {
  if (error?.code !== requiredCheckFailed || !error.failure ||
    !['review-pr', 'merge'].includes(stage)) return null;
  return { schemaVersion: 1, stage, status: 'denied', code: requiredCheckFailed,
    failure: error.failure };
}

export function failedCheckError({ repository, number, head, base }, run, job, logs) {
  const step = job.steps?.find(item =>
    ['failure', 'timed_out'].includes(item.conclusion));
  const failure = {
    number, head, base, runId: run.id, attempt: run.run_attempt, jobId: job.id,
    check: cleanName(job.name), conclusion: job.conclusion, step: cleanName(step?.name),
    url: `https://github.com/${repository}/actions/runs/${run.id}/job/${job.id}`,
  };
  // Keep raw CI logs and candidate-controlled text outside Agent input.
  const diagnostic = logs === null ? null : failureDiagnostic(logs, step);
  if (logs === null) failure.logsUnavailable = true;
  if (diagnostic) failure.diagnostic = diagnostic;
  return Object.assign(new Error(requiredCheckFailed), {
    code: requiredCheckFailed, failure,
  });
}

export function ciCorrectionFindings(failure) {
  const findings = [
    `Protected CI job ${failure.check} concluded ${failure.conclusion}` +
      (failure.step ? ` in step ${failure.step}.` : '.'),
    `Inspect and correct the failure for ${failure.head}: ${failure.url}`,
  ];
  const diagnostic = failure.diagnostic;
  if (diagnostic?.kind === 'error-code') {
    const location = diagnostic.location ? ' at ' + diagnostic.location : '';
    findings.push('CI reported ' + diagnostic.error + location + '.');
  }
  if (diagnostic?.kind === 'go-test-failures') {
    for (const test of diagnostic.tests) findings.push(
      `Go test ${test.name} failed` + (test.location ? ` at ${test.location}` : '') +
      (test.error ? ` with ${test.error}.` : '.'),
    );
  }
  if (failure.logsUnavailable) findings.push('Core could not retrieve the CI job log.');
  if (diagnostic?.kind === 'playwright-unsupported-target') {
    findings.push(
      `Playwright cannot install ${diagnostic.browser} on ${diagnostic.platform}.`,
    );
    if (diagnostic.browser.startsWith('chromium')) {
      findings.push(
        'Run the browser tests with Chrome or Chromium already on the CI runner. ' +
        'Select the installed browser in Playwright and remove the browser download ' +
        'from the test command. Keep the browser assertions enabled.',
      );
    }
  }
  return findings;
}
