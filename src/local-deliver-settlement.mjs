import { digest, requireThat } from './identity.mjs';

// Controller-only capability. Never serialize this object into a role context.
// Each stage gets a distinct ledger, even within one continue request/fence.
export function localDeliverSettlement() {
  const invocations = [];
  return {
    invocation(stage, execution) {
      const identity = digest(execution);
      const pending = new Set(['composition']);
      const entry = { stage, identity, pending };
      invocations.push(entry);
      return {
        assertExecution(current) {
          requireThat(digest(current) === identity, 'LOCAL_DELIVER_EXECUTION_CHANGED');
        },
        composed() { pending.delete('composition'); },
        enter(owner) {
          // Re-entry cannot reuse a previous owner's completion observation.
          const token = { owner };
          pending.add(token);
          let completed = false;
          return () => {
            requireThat(!completed, 'LOCAL_DELIVER_OBSERVATION_REUSED');
            completed = true;
            pending.delete(token);
          };
        },
      };
    },
    async assertSettled() {
      requireThat(invocations.length > 0 &&
        invocations.at(-1).stage === 'deliver' &&
        invocations.every(entry => entry.pending.size === 0),
      'LOCAL_DELIVER_HAND_BACK_UNPROVEN');
    },
  };
}
