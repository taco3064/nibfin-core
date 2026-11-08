import { dirname } from 'node:path';
import { boundedHostFile } from './host-adoption.mjs';
import { privateHostDirectory } from './host-fence.mjs';
import { digest, requireThat } from './identity.mjs';

const pageId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const maxBytes = 512 * 1024;

export async function readNotionProposal(adoption, {
  fetcher = fetch, readToken = async path => {
    await privateHostDirectory(dirname(path));
    return boundedHostFile(path, 4096, true);
  },
} = {}) {
  requireThat(adoption && Object.keys(adoption).sort().join(',') ===
    'pageId,tokenFile' && typeof adoption.pageId === 'string' &&
    pageId.test(adoption.pageId) && typeof adoption.tokenFile === 'string',
  'INVALID_NOTION_PROPOSAL_ADOPTION');
  let token;
  try { token = (await readToken(adoption.tokenFile)).trim(); }
  catch { requireThat(false, 'NOTION_PROPOSAL_CREDENTIAL_UNAVAILABLE'); }
  requireThat(/^[A-Za-z0-9_-]{16,512}$/.test(token),
    'NOTION_PROPOSAL_CREDENTIAL_UNAVAILABLE');
  const endpoint = 'https://api.notion.com/v1/pages/' + adoption.pageId +
    '/markdown?markdown_version=v2';
  let response;
  try {
    response = await fetcher(endpoint, { method: 'GET', redirect: 'error',
      signal: AbortSignal.timeout(20000), headers: {
        Authorization: 'Bearer ' + token, 'Notion-Version': '2026-03-11',
      } });
  } catch { requireThat(false, 'NOTION_PROPOSAL_UNAVAILABLE'); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    requireThat(response.status !== 401, 'NOTION_PROPOSAL_CREDENTIAL_REJECTED');
    requireThat(![403, 404].includes(response.status),
      'NOTION_PROPOSAL_ACCESS_DENIED');
    requireThat(false, 'NOTION_PROPOSAL_UNAVAILABLE');
  }
  const chunks = [];
  let total = 0;
  let page;
  try {
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      requireThat(total <= maxBytes, 'NOTION_PROPOSAL_INCOMPLETE');
      chunks.push(Buffer.from(chunk));
    }
    page = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { requireThat(false, 'NOTION_PROPOSAL_INCOMPLETE'); }
  requireThat(page?.object === 'page_markdown' && page.id === adoption.pageId &&
    typeof page.markdown === 'string' && page.markdown.trim() &&
    page.truncated === false && Array.isArray(page.unknown_block_ids) &&
    page.unknown_block_ids.length === 0 && !page.markdown.includes(token),
  'NOTION_PROPOSAL_INCOMPLETE');
  return { pageId: page.id, markdown: page.markdown, hash: digest(page.markdown) };
}
