import { isSha, requireThat } from './identity.mjs';
import { enforcementPaths, sameCandidate } from './candidate-evidence.mjs';
import { observationFailureCode, retryGitHubObservation }
  from './observation-failure.mjs';

// Called only inside admitted Deliver, while the host owns the exclusive fence.
// Capture partial work as well as ready Candidates; never reset a retained tree.
export async function alignDelivery(
  workspace, context, candidate, clock, partial = false,
) {
  const target = context.main?.head;
  requireThat(isSha(target) &&
    context.main.repositoryId === context.approval.record.issue.repositoryId,
  'CURRENT_MAIN_UNAVAILABLE');
  const pending = await workspace.pendingRebase?.(context.shape.body);
  if (pending) return pending;
  // Entry receipts describe the last captured delivery, not necessarily the
  // stopped Writer's actual tree. Preserve corrections before aligning it.
  const previous = candidate;
  if (partial || !candidate)
    candidate = await workspace.capture(context.shape.body, false, partial);
  const edited = Boolean(previous && !sameCandidate(candidate, previous));
  if (candidate.base === target || enforcementPaths(candidate.paths ?? []).length)
    return { status: 'unchanged', candidate,
      ...(edited ? { contentChanged: true } : {}) };
  const result = await workspace.rebase(candidate, context.shape.body, target,
    new Date(clock()).toISOString(), partial);
  return edited ? { ...result, contentChanged: true } : result;
}

// No Writer may start here. Conflicts or changed content return to normal stage
// admission, including authorization, isolation and the single-Writer fence.
export async function handoffDelivery({
  workspace, context, candidate, observeMain, clock, partial = false,
}) {
  let main;
  try {
    requireThat(typeof observeMain === 'function', 'CURRENT_MAIN_UNAVAILABLE');
    main = await retryGitHubObservation(() => observeMain(context), { clock });
    requireThat(isSha(main?.head) &&
      main.repositoryId === context.approval.record.issue.repositoryId,
    'CURRENT_MAIN_UNAVAILABLE');
  } catch (error) {
    return { outcome: 'blocked', candidate, findings: [
      `Candidate retained: handoff main observation failed ` +
        `(${observationFailureCode(error)}).`,
    ] };
  }
  const aligned = await alignDelivery(
    workspace, { ...context, main }, candidate, clock, partial,
  );
  if (aligned.status === 'changes_required' || aligned.contentChanged)
    return { outcome: 'changes_required',
      ...(aligned.candidate ? { candidate: aligned.candidate } : {}), findings: [
      aligned.status === 'changes_required'
        ? 'Resolve the retained main rebase conflicts within the approved Shape.'
        : 'Main advanced during Deliver; verify the changed rebased content.',
    ] };
  return { candidate: aligned.candidate };
}
