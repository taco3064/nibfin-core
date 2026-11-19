import test from 'node:test';
import assert from 'node:assert/strict';
import { readCallerSource } from '../src/caller-source.mjs';
import { gitBlob } from '../src/identity.mjs';
import { callerRecipe, callerRecipeVariants } from '../src/caller-recipes.mjs';
import { deliveryRoleTimeout, deliveryTransportTimeout } from '../src/process.mjs';

test('delivery callers give Core time to stop and clean up its role', () => {
  for (const kind of ['action-wake', 'action-dispatch']) {
    const body = callerRecipe(kind, 'a'.repeat(40), {
      actionCommit: 'b'.repeat(40), memberId: 2,
    });
    const jobMinutes = Number(body.match(/^    timeout-minutes: (\d+)$/m)?.[1]);
    assert.equal(jobMinutes, 180);
    assert.ok(deliveryRoleTimeout < jobMinutes * 60_000);
    assert.ok(deliveryTransportTimeout > jobMinutes * 60_000);
  }
});

for (const kind of ['wake', 'action-wake', 'action-dispatch']) {
  test(
    `${kind}: ordinary main advances preserve adopted caller, but ` +
      'rewrite or edit/restore revokes it',
    async () => {
      const coreCommit = 'c'.repeat(40);
      const recipe = {
        kind: kind === 'action-dispatch' ? 'action-wake' : kind,
        coreCommit, actionCommit: 'd'.repeat(40), memberId: 2,
      };
      const body = callerRecipe(kind, coreCommit, recipe),
        anchor = 'a'.repeat(40),
        head = 'b'.repeat(40);
      const pin = {
        commit: anchor,
        path: '.github/workflows/nibfin.yml',
        blob: gitBlob(body),
      };
      const data = {};
      for (const sha of [anchor, head]) {
        data[`/contents/${pin.path}?ref=${sha}`] = {
          type: 'file',
          path: pin.path,
          sha: pin.blob,
          content: Buffer.from(body).toString('base64'),
          encoding: 'base64',
          size: Buffer.byteLength(body),
        };
        data[`/commits?sha=${sha}&path=${encodeURIComponent(pin.path)}&per_page=1`] = [
          { sha: anchor },
        ];
      }
      data[`/compare/${anchor}...${head}`] = {
        status: 'ahead',
        merge_base_commit: { sha: anchor },
      };
      const reader = {
        get: async (path) =>
          structuredClone(data[path.replace('/repos/example/core', '')]),
      };
      assert.equal(
        await readCallerSource(reader, 'example/core', pin, head, recipe),
        head,
      );
      assert.equal(await readCallerSource(reader, 'example/core',
        { ...pin, blob: '0'.repeat(40) }, head, recipe), head);
      if (recipe.kind === 'action-wake') {
        for (const changed of [{ actionCommit: 'e'.repeat(40) }, { memberId: 3 }]) {
          await assert.rejects(
            readCallerSource(reader, 'example/core', pin, head, {
              ...recipe,
              ...changed,
            }),
            /CALLER_NOT_FIXED_RECIPE/,
          );
        }
      }
      await assert.rejects(
        readCallerSource(reader, 'example/core', pin, head),
        /CALLER_EXACT_COMMIT_REQUIRED/,
      );
      await assert.rejects(
        readCallerSource(reader, 'example/core', pin, head, {
          kind: 'issue',
          coreCommit,
        }),
        /CALLER_NOT_FIXED_RECIPE/,
      );
      data[`/commits?sha=${head}&path=${encodeURIComponent(pin.path)}&per_page=1`] = [
        { sha: head },
      ];
      await assert.rejects(
        readCallerSource(reader, 'example/core', pin, head),
        /CALLER_REVOKED_OR_SUPERSEDED/,
      );
      data[`/compare/${anchor}...${head}`].status = 'diverged';
      await assert.rejects(
        readCallerSource(reader, 'example/core', pin, head),
        /CALLER_SOURCE_NOT_DESCENDANT/,
      );
    },
  );
}

for (const kind of ['wake', 'action-wake', 'action-dispatch', 'issue',
  'issue-managed']) {
  test(`${kind}: exact titled and historical variants retain admission bounds`,
    async () => {
      const commit = 'c'.repeat(40);
      const recipe = { kind, coreCommit: commit,
        actionCommit: 'd'.repeat(40), memberId: 2 };
      const path = '.github/workflows/nibfin.yml';
      let source;
      const reader = { get: async () => ({ type: 'file', path,
        encoding: 'base64', content: Buffer.from(source).toString('base64') }) };
      const read = (change = {}) => readCallerSource(reader, 'example/core',
        { path }, commit, { ...recipe, ...change });
      const variants = callerRecipeVariants(kind, commit, recipe);
      assert.equal(variants.length, 2);
      for (const variant of variants) {
        for (const newline of ['\n', '\r\n']) {
          source = variant.replaceAll('\n', newline);
          assert.equal(await read(), commit);
          await assert.rejects(read({ coreCommit: 'e'.repeat(40) }),
            /CALLER_NOT_FIXED_RECIPE/);
          if (kind.startsWith('action-')) {
            await assert.rejects(read({ memberId: 3 }), /CALLER_NOT_FIXED_RECIPE/);
            await assert.rejects(read({ actionCommit: 'e'.repeat(40) }),
              /CALLER_NOT_FIXED_RECIPE/);
          }
          source += 'env: { UNEXPECTED: content }\n';
          await assert.rejects(read(), /CALLER_NOT_FIXED_RECIPE/);
        }
      }
      source = variants[1].replace('\non:', '\nrun-name: arbitrary\non:');
      await assert.rejects(read(), /CALLER_NOT_FIXED_RECIPE/);
    });
}
