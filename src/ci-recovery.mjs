export const requiredCheckFailed = 'CI_REQUIRED_CHECK_FAILED';

function failureDiagnostic(logs, step) {
  const start = Date.parse(step?.started_at);
  const end = Date.parse(step?.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
  for (const line of logs.split('\n')) {
    const entry = /^(\S+) (.*)$/.exec(line);
    if (!entry) continue;
    const time = Date.parse(entry[1]);
    if (!Number.isFinite(time) || time < start || time >= end + 1000) continue;
    const message = entry[2].replace(/\x1b\[[0-9;]*m/g, '').trim();
    const unsupported = /^(?:Error: )?(?:ERROR: )?Playwright does not support /.test(
      message,
    );
    if (!unsupported) continue;
    const target = / (chromium-headless-shell|chromium|firefox|webkit) on (\S+)$/
      .exec(message);
    if (target && /^ubuntu\d{2}\.\d{2}-(?:x64|arm64)$/.test(target[2]))
      return { kind: 'playwright-unsupported-target',
      browser: target[1], platform: target[2] };
  }
  return null;
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
  const diagnostic = failureDiagnostic(logs, step);
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
  if (diagnostic?.kind === 'playwright-unsupported-target') {
    findings.push(
      `Playwright cannot install ${diagnostic.browser} on ${diagnostic.platform}.`,
    );
  }
  return findings;
}
