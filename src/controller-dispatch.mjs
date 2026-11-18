import { launchStage, reconcileStage } from './host-launcher.mjs';
import { launchIssueWake } from './host-issue-wake.mjs';

// Called only after fixed-transport caller authentication and input validation.
export function dispatchControllerRequest(request, runnerUid, handlers = {
  stage: launchStage, reconcile: reconcileStage, event: launchIssueWake,
}) {
  if (request.command === 'reconcile-stage')
    return handlers.reconcile(request.issue, request.stage, request.context, runnerUid);
  if (request.command === 'stage')
    return handlers.stage(request.issue, request.stage, request.context, runnerUid);
  return handlers.event(request.issue, request.context, request.event, runnerUid);
}
