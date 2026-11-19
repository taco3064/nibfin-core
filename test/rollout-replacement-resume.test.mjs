import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../src/identity.mjs';
import { OperationJournal } from '../src/operation-journal.mjs';
import { WakeDispatcher } from '../src/wakeup.mjs';
import { recoverReplacementWake, recoverStaleOrigin }
  from '../src/rollout-recovery.mjs';

for (const adapter of ['relay', 'legacy']) {
  for (const interruption of ['association', 'observation', 'admission', 'post']) {
    test(`${adapter} resumes ${interruption} only when dispatch is proven unstarted`,
      async t => {
        const root = await mkdtemp(join(tmpdir(), 'replacement-resume-'));
        t.after(() => rm(root, { recursive: true, force: true }));
        const directory = join(root, adapter);
        const issue = { id: 'I_old', repositoryId: 1,
          repository: 'example/core', number: 2 };
        const record = { status: 'consumed', runId: 10, origin: { runId: 2 },
          intent: { source: { coreCommit: 'a'.repeat(40) } } };
        const current = 'b'.repeat(40);
        const initial = { issue, actorId: 3, workflow: { id: 5,
          path: '.github/workflows/wake.yml', ref: 'main', commit: current } };
        let association, admissions = 0, settlements = 0, posts = 0;
        const journal = () => new OperationJournal(directory, issue);
        const ports = {
          reconcile: async () => {},
          attempt: async () => ({ id: 10, run_attempt: 1,
            status: 'completed', conclusion: 'failure' }),
          read: async () => association,
          write: async (unused, value) => { association = value; },
          admit: async () => { admissions++; },
          settle: async () => { settlements++; },
          recover: () => recoverReplacementWake({ directory, issue,
            uid: process.getuid(), token: 'fixture' }),
          dispatch: async () => {
            if (interruption === 'association') throw new Error('Interrupted');
            await mkdir(directory, { mode: 0o700 });
            if (interruption === 'admission') {
              const bindingHash = digest(initial);
              return journal().run({ operation: 'wake', bindingHash,
                observation: initial }, {
                admit: async () => { throw new Error('Admission changed'); },
                perform: async () => assert.fail('No POST before admission'),
                readBack: async () => assert.fail(),
              });
            }
            return new WakeDispatcher({ token: 'fixture', journal: journal(),
              observe: async () => {
                if (interruption === 'observation')
                  throw Object.assign(new Error('Unavailable'), { status: 503 });
                return initial;
              },
              fetcher: async () => { posts++; throw new Error('Lost POST'); },
            }).dispatch();
          },
        };
        try { await recoverStaleOrigin(record, current, ports); }
        catch (error) { assert.equal(error.message, 'Interrupted'); }
        assert.equal(association.status, 'pending');
        // Normal current admission must be re-entered for an unstarted effect.
        ports.admit = async () => {
          admissions++;
          throw new Error('Currently paused');
        };
        if (interruption !== 'post') {
          await assert.rejects(recoverStaleOrigin(record, current, ports),
            { message: 'Currently paused' });
          assert.equal(settlements, 1);
        }
        ports.admit = async () => { admissions++; };
        ports.dispatch = async () => {
          posts++;
          return { status: 'scheduled', runId: 20 };
        };
        const result = await recoverStaleOrigin(record, current, ports);
        if (interruption === 'post') {
          assert.equal(result.code, 'EXTERNAL_EFFECT_UNKNOWN');
          assert.equal(admissions, 1);
          assert.equal(settlements, 1);
          assert.equal(posts, 1);
        } else {
          assert.equal(result.runId, 20);
          assert.equal(settlements, 2);
          assert.equal(posts, 1);
          await recoverStaleOrigin(record, current, ports);
          assert.equal(posts, 1);
        }
      });
  }
}

test('a retained journal lock cannot prove an unstarted replacement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'replacement-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const issue = { id: 'I_old', repositoryId: 1 };
  const journal = new OperationJournal(root, issue);
  await journal.assertIdle();
  const directory = join(root, digest({ issueId: issue.id, repositoryId: 1 }));
  await writeFile(join(directory, 'execution.lock'), '{}', { mode: 0o600 });
  assert.deepEqual(await recoverReplacementWake({ directory: root, issue }),
    { status: 'pending', code: 'WRITER_NOT_PROVEN_TERMINATED' });
});
