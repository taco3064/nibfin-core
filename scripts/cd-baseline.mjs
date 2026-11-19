// A display title is not deployment state. Native success and the verified-main
// job establish that this automatic run actually accepted its main source.
export function cdBaseline(run, jobs) {
  if (run.event !== 'workflow_run' || run.conclusion !== 'success' ||
    run.head_branch !== 'main' || !run.repository?.id ||
    run.head_repository?.id !== run.repository.id ||
    !/^[a-f0-9]{40}$/.test(run.head_sha ?? '') ||
    !jobs?.some(job => job.name === 'verified-main' &&
      job.conclusion === 'success')) return undefined;
  return run.head_sha;
}
