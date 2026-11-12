import { GitHubWriter } from './github-write.mjs';
import { readMemberPermission } from './github-approval.mjs';
import { digest, requireThat } from './identity.mjs';
import {
  observePause,
  interpretPause,
  pauseEvent,
  qualifyPauseEvent,
} from './pause.mjs';

export function pauseTrigger(event) {
  return (
    ['labeled', 'unlabeled'].includes(event?.action) && event.label?.name === 'pause'
  );
}

function snapshot(issue) {
  return {
    node_id: issue?.node_id,
    number: issue?.number,
    state: issue?.state,
    updated_at: issue?.updated_at,
    assignees: issue?.assignees?.map((user) => ({
      id: user.id,
      login: user.login,
      type: user.type,
    })),
    labels: issue?.labels
      ?.filter((label) => ['pause', 'delivered'].includes(label.name))
      .map((label) => ({ name: label.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// Invoked exclusively after the existing event/source and host authentication.
// A webhook locates the native event. It cannot itself authorize the writer.
export async function reconcilePause({
  reader,
  issue,
  event,
  journal,
  inspect,
  token,
  actorId,
  fetcher = fetch,
}) {
  try {
    await inspect();
    let evidence = await journal.pauseEvidence();
    requireThat(!evidence.pending, 'EXTERNAL_EFFECT_UNKNOWN');
    let observed = await observePause(reader, issue, evidence.decisions);
    requireThat(Array.isArray(observed.events), observed.code);
    const events = observed.events.filter(pauseEvent);
    const native = events.at(-1);
    requireThat(
      native &&
        native.actor.id === event.sender?.id &&
        native.actor.login === event.sender.login &&
        native.event === event.action &&
        native.created_at === event.issue?.updated_at,
      'PAUSE_EVENT_NOT_CURRENT',
    );
    const recorded = evidence.decisions.find(
      (proof) => proof.eventHash === digest(native),
    );
    if (!recorded) {
      // Qualify only an authenticated, coherent current event. Older native
      // events without a journal receipt remain Unknown, including after moves
      // to a host lacking that journal. Never requalify a recorded operation.
      requireThat(
        digest(snapshot(event.issue)) === digest(snapshot(observed.current)),
        'PAUSE_EVENT_SNAPSHOT_CHANGED',
      );
      const prefix = interpretPause({
        issue: {
          labels:
            events.length > 1 && events.at(-2).event === 'labeled'
              ? [{ name: 'pause' }]
              : [],
        },
        events: observed.events.filter((item) => item.id < native.id),
        decisions: evidence.decisions,
      });
      requireThat(typeof prefix.effective === 'boolean', 'PAUSE_HISTORY_UNKNOWN');
      const qualification = await qualifyPauseEvent(
        reader,
        observed,
        native,
        event.issue,
      );
      requireThat(qualification !== 'unknown', 'PAUSE_QUALIFICATION_UNKNOWN');
      const proof = {
        eventHash: digest(native),
        observationHash: observed.observationHash,
        qualification,
        desired:
          qualification === 'allowed' ? native.event === 'labeled' : prefix.effective,
      };
      const fresh = await observePause(reader, issue, evidence.decisions);
      requireThat(
        fresh.observationHash === observed.observationHash,
        'PAUSE_OBSERVATION_CHANGED',
      );
      await inspect();
      requireThat(
        (await qualifyPauseEvent(reader, fresh, native, event.issue)) === qualification,
        'PAUSE_QUALIFICATION_CHANGED',
      );
      const recorded = await journal.recordPauseDecision(proof);
      requireThat(recorded.status === 'completed', 'PAUSE_JOURNAL_UNAVAILABLE');
      evidence = await journal.pauseEvidence();
      observed = await observePause(reader, issue, evidence.decisions);
    }
    if (!observed.repair) return observed;
    const bindingHash = observed.observationHash;
    const desired = observed.effective;
    const authority = async () => {
      await inspect();
      const actor = await reader.get('/user');
      requireThat(actor.id === actorId, 'PAUSE_REPAIR_ACTOR_CHANGED');
      await readMemberPermission(reader, issue.repository, actor);
      const freshEvidence = await journal.pauseEvidence();
      const fresh = await observePause(reader, issue, freshEvidence.decisions);
      requireThat(
        fresh.observationHash === bindingHash &&
          fresh.repair &&
          fresh.effective === desired,
        'PAUSE_REPAIR_OBSERVATION_CHANGED',
      );
      return actor;
    };
    const actor = await authority();
    const writer = new GitHubWriter({
      reader,
      token,
      fetcher,
      guard: async ({ operation, targetHash }) => {
        requireThat(operation === 'repair-pause', 'INVALID_PAUSE_REPAIR');
        await authority();
        return { targetHash, bindingHash };
      },
    });
    const result = await journal.repairPause(
      { bindingHash, desired },
      {
        admit: async () => {
          await authority();
          return bindingHash;
        },
        perform: () =>
          writer.repairPause({
            issue,
            desired,
            expectedBodyHash: digest(observed.current.body),
            expectedLabels: observed.current.labels.map((label) => label.name),
          }),
        readBack: async () => {
          const after = await observePause(reader, issue, evidence.decisions);
          requireThat(
            Array.isArray(after.events) &&
              digest(after.events.slice(0, observed.events.length)) ===
                digest(observed.events),
            'PAUSE_REPAIR_HISTORY_CHANGED',
          );
          const added = after.events.slice(observed.events.length).filter(pauseEvent);
          requireThat(
            added.length === 1 &&
              added[0].actor.id === actor.id &&
              added[0].event === (desired ? 'labeled' : 'unlabeled') &&
              after.current.labels.some((label) => label.name === 'pause') === desired,
            'PAUSE_REPAIR_EVENT_UNKNOWN',
          );
          const proof = {
            eventHash: digest(added[0]),
            qualification: 'repair',
            observationHash: bindingHash,
            desired,
          };
          const verified = interpretPause({ issue: after.current, events: after.events,
            decisions: [...evidence.decisions, proof] });
          requireThat(verified.status === (desired ? 'paused' : 'clear'),
            'PAUSE_REPAIR_READBACK_UNKNOWN');
          return proof;
        },
      },
    );
    if (result.status !== 'completed') return { ...result, status: 'pending' };
    return observePause(reader, issue, (await journal.pauseEvidence()).decisions);
  } catch (error) {
    return { status: 'pending', code: error.code ?? 'PAUSE_RECONCILIATION_UNKNOWN' };
  }
}
