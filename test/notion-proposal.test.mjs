import assert from 'node:assert/strict';
import test from 'node:test';
import { readNotionProposal } from '../src/notion-proposal.mjs';
import { createHash } from 'node:crypto';

const pageId = '40006b64-4a20-80da-b1a8-c2e562f95373';
const adoption = { pageId, tokenFile: '/private/notion-token' };
const token = 'notion-unit-test-placeholder';
const readToken = async path => {
  assert.equal(path, adoption.tokenFile);
  return token;
};
const page = { object: 'page_markdown', id: pageId,
  markdown: '# Proposal\n\n## UTF-8: 光\n',
  truncated: false, unknown_block_ids: [] };

test('Proposal read binds the adopted page and returns only evidence', async () => {
  const result = await readNotionProposal(adoption, { readToken,
    fetcher: async (url, request) => {
      assert.equal(url, 'https://api.notion.com/v1/pages/' + pageId +
        '/markdown?markdown_version=v2');
      assert.equal(request.method, 'GET');
      assert.equal(request.redirect, 'error');
      assert.equal(request.headers.Authorization, 'Bearer ' + token);
      return Response.json(page);
    },
  });
  assert.deepEqual(result, { pageId, markdown: page.markdown,
    hash: createHash('sha256').update(page.markdown, 'utf8').digest('hex') });
});

test('Proposal read rejects partial, foreign, oversized or credential-bearing data',
  async () => {
    for (const invalid of [
      { truncated: true }, { unknown_block_ids: [pageId] },
      { id: 'wrong-page' }, { markdown: 'a'.repeat(512 * 1024) },
      { markdown: token },
    ]) {
      const fetcher = async () => Response.json({ ...page, ...invalid });
      await assert.rejects(readNotionProposal(adoption, { readToken, fetcher }),
        { code: 'NOTION_PROPOSAL_INCOMPLETE' });
    }
  });

test('Proposal read reports credential and sharing failures without API bodies',
  async () => {
    for (const [status, code] of [
      [401, 'NOTION_PROPOSAL_CREDENTIAL_REJECTED'],
      [403, 'NOTION_PROPOSAL_ACCESS_DENIED'],
      [404, 'NOTION_PROPOSAL_ACCESS_DENIED'],
      [429, 'NOTION_PROPOSAL_UNAVAILABLE'],
    ]) {
      const fetcher = async () => new Response(token, { status });
      await assert.rejects(readNotionProposal(adoption, { readToken, fetcher }),
        { message: code, code });
    }
  });
