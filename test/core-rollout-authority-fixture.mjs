import { verifyManagedAuthority } from '../src/managed-credential-authority.mjs';
import { GitHubReader } from '../src/github-read.mjs';
import { rolloutFailure } from '../src/core-rollout-result.mjs';

// Exercise the actual authority producer, including its 401/API sanitization.
export async function authorityResult(kind) {
  const host = { memberId: kind === 'invalid' ? 0 : 5,
    credentialRepositories: [{ repository: 'example/core', repositoryId: 1 }] };
  const reader = new GitHubReader('fake-fixture-token', async url => {
    if (['401', '422'].includes(kind))
      return new Response('', { status: Number(kind) });
    if (new URL(url).pathname === '/user') return Response.json({
      id: kind === 'member' ? 6 : 5, login: 'owner', type: 'User' });
    if (url.endsWith('/permission')) return Response.json({ user: { id: 5 },
      permission: kind === 'admin' ? 'write' : 'admin' });
    return Response.json({ id: kind === 'repository' ? 2 : 1,
      full_name: 'example/core', archived: false, disabled: false });
  });
  try {
    await verifyManagedAuthority(host, 'fake-fixture-token', reader);
    throw Error('The negative authority fixture unexpectedly succeeded');
  } catch (error) { return rolloutFailure(error); }
}
