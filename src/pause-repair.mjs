import { GitHubWriter } from './github-write.mjs';
import { digest, isId, requireThat } from './identity.mjs';
import { observePause, pauseLabels } from './pause.mjs';
import { GitHubReader, issuePath } from './github-read.mjs';

// The installed controller supplies authority/inspection and a private journal.
// An observation describes a negative restriction; it grants no write authority.
export async function reconcilePause({
  reader, issue, token, journal, authorize, fetcher, event,
}) {
  try {
    const credential = new GitHubReader(token, fetcher);
    const authorityForWrite = async () => {
      const approved = await authorize();
      const actor = await credential.get('/user');
      requireThat(isId(approved.actorId) && actor.id === approved.actorId,
        'PAUSE_REPAIR_CREDENTIAL_CHANGED');
      return approved;
    };
    let proofs = await journal.pauseEffects();
    let initial = await observePause(reader, issue, proofs, event);
    if (initial.authorization) {
      const observed = initial;
      const authority = await authorityForWrite();
      await journal.recordPauseAuthorization(observed.authorization, async () => {
        requireThat(digest(await authorityForWrite()) === digest(authority),
          'PAUSE_REPAIR_AUTHORITY_CHANGED');
        const current = await observePause(reader, issue, proofs, event);
        requireThat(current.observationHash === observed.observationHash &&
          digest(current.authorization) === digest(observed.authorization),
        'PAUSE_AUTHORIZATION_CHANGED');
      });
      proofs = await journal.pauseEffects();
      initial = await observePause(reader, issue, proofs);
    }
    if (initial.status !== 'repair') return initial;
    const authority = await authorityForWrite();
    const bindingHash = digest({ issue, authority,
      observationHash: initial.observationHash, desired: initial.desired });
    const freshGuard = async () => {
      requireThat(digest(await authorityForWrite()) === digest(authority),
        'PAUSE_REPAIR_AUTHORITY_CHANGED');
      const current = await observePause(reader, issue, proofs, event);
      requireThat(current.status === 'repair' &&
        current.observationHash === initial.observationHash &&
        current.rejectedEventId === initial.rejectedEventId,
        'PAUSE_REPAIR_OBSERVATION_CHANGED');
      return bindingHash;
    };
    let effect;
    const result = await journal.run({ operation: 'pause-repair', bindingHash }, {
      admit: freshGuard,
      perform: async () => {
        const writer = new GitHubWriter({ reader, token, fetcher,
          guard: async ({ operation, targetHash }) => {
            requireThat(operation === 'pause-repair', 'INVALID_PAUSE_OPERATION');
            return { targetHash, bindingHash: await freshGuard() };
          } });
        await writer.repairPause({ issue,
          expectedBodyHash: digest(initial.current.body),
          expectedLabels: pauseLabels(initial.current), desired: initial.desired });
        const all = await reader.list(`${issuePath(issue)}/events`);
        const events = all.filter(event =>
          ['labeled', 'unlabeled'].includes(event?.event) &&
          event.label?.name === 'pause');
        requireThat(events.length === initial.events.length + 1 &&
          digest(events.slice(0, -1)) === digest(initial.events),
        'PAUSE_REPAIR_EVENT_UNKNOWN');
        const event = events.at(-1);
        requireThat(isId(event.id) && event.actor?.id === authority.actorId &&
          event.event === (initial.desired ? 'labeled' : 'unlabeled'),
        'PAUSE_REPAIR_EVENT_UNKNOWN');
        effect = { issueId: issue.id, repositoryId: issue.repositoryId,
          beforeHash: digest(initial.events), eventId: event.id,
          actorId: authority.actorId, desired: initial.desired,
          ...(initial.rejectedEventId
            ? { rejectedEventId: initial.rejectedEventId } : {}),
        };
        return effect;
      },
      readBack: async () => {
        const observed = await observePause(reader, issue, [...proofs, effect]);
        requireThat(observed.status === (initial.desired ? 'paused' : 'clear'),
          'PAUSE_REPAIR_READBACK_UNKNOWN');
        return bindingHash;
      },
    });
    if (result.status !== 'completed')
      return { status: 'unknown', code: result.code };
    return observePause(reader, issue, await journal.pauseEffects());
  } catch (error) {
    return { status: 'unknown', code: error.code ?? 'PAUSE_REPAIR_UNKNOWN' };
  }
}
