import test from 'node:test';
import assert from 'node:assert/strict';
import { readCallerSource } from '../src/caller-source.mjs';
import { gitBlob } from '../src/identity.mjs';
import { callerRecipe } from '../src/caller-recipes.mjs';

for (const kind of ['wake', 'action-wake']) {
  test(
    `${kind}: ordinary main advances preserve adopted caller, but ` +
      'rewrite or edit/restore revokes it',
    async () => {
      const coreCommit = 'c'.repeat(40);
      const recipe = { kind, coreCommit, actionCommit: 'd'.repeat(40), memberId: 2 };
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
      if (kind === 'action-wake') {
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
