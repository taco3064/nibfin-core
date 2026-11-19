import { repoPath } from './github-read.mjs';
import { targetTitleInput } from './dispatch-presentation.mjs';
import { isId, requireThat } from './identity.mjs';
import { sharedDispatchWorkflow } from './shared-runner.mjs';
import { resolveSharedIssueWake } from './issue-wake.mjs';
import { readMemberPermission } from './github-approval.mjs';
import { relayBounds, boundedBody, downloadRelayArtifact } from './relay-http.mjs';
import { readRelayArchive, readRelayPayload } from './relay-artifact.mjs';
import { withRelayGate, readRelayState, writeRelayState } from './relay-state.mjs';
import {
  observeRelayOrigin, observeRelayAttempt, observeRelayArtifact, reconcileRelayRun,
} from './relay-observe.mjs';

const pending = runId => ({ status: 'pending', code: 'RELAY_EFFECT_UNKNOWN',
  ...(runId ? { runId } : {}) });

// Trusted adapters supply credentials, adoption, and storage. Artifacts supply locators.
export class NotificationRelay {
  constructor({ reader, token, journal, configuration, inspect, fetcher = fetch,
    now = () => Date.now(), requireAdmission = async () => {} }) {
    Object.assign(this, { reader, token, journal, configuration, inspect, fetcher, now,
      requireAdmission });
  }
  async #reconcile(record) {
    if (record.nextReadAt > this.now()) return pending(record.runId);
    try {
      const runId = record.runId;
      await reconcileRelayRun(this.reader, record.intent, runId);
      await this.journal.write({ ...record, status: 'consumed' });
      return { status: 'consumed', runId, stageAdmitted: false };
    } catch (error) {
      if (error.backoff) await this.journal.write({ ...record,
        nextReadAt: this.now() + error.backoff });
      return pending(record.runId);
    }
  }
  async process(origin, runId) {
    return withRelayGate(this.journal.root, async () => {
      const key = { repositoryId: origin.repositoryId, runId, attempt: 1 };
      const previous = await this.journal.read(key);
      if (previous) return previous.status === 'pending' ? this.#reconcile(previous)
        : { status: previous.status, code: 'RELAY_REPLAY', runId: previous.runId };
      if ((await this.journal.control()).paused)
        return { status: 'paused', code: 'RELAY_PAUSED' };
      await this.requireAdmission();
      requireThat((await this.journal.records()).length < 4096,
        'RELAY_JOURNAL_CAPACITY');
      const config = this.configuration;
      await this.inspect();
      await observeRelayOrigin(this.reader, origin, config.coreCommit);
      const run = await observeRelayAttempt(
        this.reader, origin, runId, config.coreCommit, { historical: true });
      const artifact = await observeRelayArtifact(this.reader, origin, run);
      if (artifact.expired) {
        await this.journal.write({ origin: key, status: 'skipped',
          code: 'RELAY_ORIGINAL_EXPIRED' });
        return { status: 'skipped', code: 'RELAY_ORIGINAL_EXPIRED' };
      }
      const archive = await downloadRelayArtifact(this.reader, origin.repository,
        artifact.id, this.fetcher);
      const payload = readRelayPayload(readRelayArchive(archive, artifact.digest),
        origin, runId);
      // Recheck every admission observation after artifact download, under the same
      // gate as local pause. No cached routing or source observation admits a POST.
      await this.inspect();
      await observeRelayOrigin(this.reader, origin, config.coreCommit);
      const actor = await this.reader.get('/user');
      requireThat(actor.id === config.memberId && actor.type === 'User',
        'RELAY_CONTROLLER_CHANGED');
      await readMemberPermission(this.reader, origin.repository, actor);
      const route = await resolveSharedIssueWake(this.reader, payload.event, {
        repository: origin.repository, coreCommit: config.coreCommit,
        eventName: 'issues', attempt: 1, runId, shared: true, forwarded: true,
        managed: true,
      });
      requireThat(Number(route.member_id) === actor.id, 'RELAY_ROUTE_CHANGED');
      const destination = await sharedDispatchWorkflow(this.reader, config.runner);
      const intent = {
        origin: key, destination,
        source: { repository: origin.repository, workflow: origin.workflow,
          head: run.head_sha, coreCommit: config.coreCommit, artifactId: artifact.id,
          artifactDigest: artifact.digest },
        actor: { id: actor.id, login: actor.login },
        issue: { repositoryId: origin.repositoryId, repository: origin.repository,
          number: payload.event.issue.number, id: payload.event.issue.node_id },
        inputs: { repository_id: String(origin.repositoryId),
          ...targetTitleInput(destination, origin.repository),
          issue_number: route.issue_number, issue_id: payload.event.issue.node_id,
          stage: 'wake', wake_event: JSON.stringify({ event: payload.event, runId }) },
        // Native run timestamps have second precision. Preserve that precision
        // when binding the request window rather than rejecting same-second runs.
        createdAt: new Date(Math.floor(this.now() / 1000) * 1000).toISOString(),
      };
      requireThat(!(await this.journal.control()).paused, 'RELAY_PAUSED');
      await this.requireAdmission();
      const record = { origin: key, status: 'pending', intent };
      await this.journal.write(record);
      try {
        const response = await this.fetcher('https://api.github.com' +
          `${repoPath(destination.repository)}/actions/workflows/` +
          `${destination.id}/dispatches`, {
          method: 'POST', redirect: 'error',
          signal: AbortSignal.timeout(relayBounds.timeout),
          headers: { Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
            'Accept-Encoding': 'identity', 'X-GitHub-Api-Version': '2026-03-10' },
          body: JSON.stringify({ ref: destination.ref, inputs: intent.inputs }),
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          requireThat(false, 'RELAY_DISPATCH_UNKNOWN');
        }
        const result = JSON.parse((await boundedBody(response, 4096)).toString('utf8'));
        requireThat(isId(result.workflow_run_id) && result.html_url ===
          `https://github.com/${destination.repository}/actions/runs/` +
          result.workflow_run_id, 'RELAY_DISPATCH_UNKNOWN');
        record.runId = result.workflow_run_id;
        await this.journal.write(record);
        return this.#reconcile(record);
      } catch { return pending(record.runId); }
    });
  }
  async poll() {
    const results = [];
    // Pending receipts are recovery evidence, independent of artifact retention.
    for (const record of await this.journal.records()) {
      if (record.status !== 'pending') continue;
      results.push(await withRelayGate(this.journal.root, async () => {
        const current = await this.journal.read(record.origin);
        return current.status === 'pending' ? this.#reconcile(current)
          : { status: current.status };
      }));
      if (results.length >= 50) return { status: 'pending', results };
    }
    for (const origin of this.configuration.origins) {
      const name = `poll-${origin.repositoryId}.json`;
      try {
        const prior = await readRelayState(this.journal.root, name);
        if (prior?.nextAt > this.now()) continue;
        await this.inspect();
        await observeRelayOrigin(this.reader, origin, this.configuration.coreCommit);
        const since = new Date(this.now() - relayBounds.window).toISOString();
        const found = await this.reader.discovery(origin, encodeURIComponent(since),
          prior?.etag);
        let allTerminal = true, backoff = relayBounds.interval;
        const seen = new Set();
        for (const run of found.runs ?? []) {
          if (!isId(run?.id) || seen.has(run.id)) continue;
          seen.add(run.id);
          try {
            const result = await this.process(origin, run.id);
            results.push(result);
            if (!['consumed', 'skipped'].includes(result.status)) allTerminal = false;
          } catch (error) {
            allTerminal = false;
            results.push({ status: 'denied', code: safeRelayCode(error) });
            backoff = Math.max(backoff, error.backoff ?? 0);
            if ([403, 429].includes(error.status)) break;
          }
        }
        // Never let a 304 suppress retries of incomplete, unready or paused runs.
        await withRelayGate(this.journal.root, () => writeRelayState(this.journal.root,
          name, { nextAt: this.now() + backoff,
            etag: found.unchanged ? prior?.etag ?? null
              : allTerminal && found.complete ? found.etag : null }));
      } catch (error) {
        await withRelayGate(this.journal.root, () => writeRelayState(this.journal.root,
          name, { nextAt: this.now() + (error.backoff ?? 60000), etag: null }));
        results.push({ status: 'denied', code: safeRelayCode(error) });
      }
    }
    requireThat(results.length <= 1700, 'RELAY_DIAGNOSTIC_LIMIT');
    return { status: results.some(item => item.status === 'pending') ? 'pending'
      : 'observed', results, stageAdmitted: false };
  }
}

export function safeRelayCode(error) {
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(error?.code ?? '')
    ? error.code : 'RELAY_OBSERVATION_UNAVAILABLE';
}
