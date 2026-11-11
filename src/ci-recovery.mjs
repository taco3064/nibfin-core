export const requiredCheckFailed = 'CI_REQUIRED_CHECK_FAILED';

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

export function failedCheckError({ repository, number, head, base }, run, job) {
  const step = job.steps?.find(item =>
    ['failure', 'timed_out'].includes(item.conclusion));
  const failure = {
    number, head, base, runId: run.id, attempt: run.run_attempt, jobId: job.id,
    check: cleanName(job.name), conclusion: job.conclusion, step: cleanName(step?.name),
    url: `https://github.com/${repository}/actions/runs/${run.id}/job/${job.id}`,
  };
  return Object.assign(new Error(requiredCheckFailed), {
    code: requiredCheckFailed, failure,
  });
}

export function ciCorrectionFindings(failure) {
  return [
    `Protected CI job ${failure.check} concluded ${failure.conclusion}` +
      (failure.step ? ` in step ${failure.step}.` : '.'),
    `Inspect and correct the failure for ${failure.head}: ${failure.url}`,
  ];
}
