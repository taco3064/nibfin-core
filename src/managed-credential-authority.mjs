import { GitHubReader, repoPath } from './github-read.mjs';
import { requireThat, isId } from './identity.mjs';

// Never propagate provider exceptions, response bodies, logins or token bytes.
export async function verifyManagedAuthority(
  host, token, reader = new GitHubReader(token),
) {
  try {
    requireThat(isId(host.memberId) && Array.isArray(host.credentialRepositories) &&
      host.credentialRepositories.length > 0 &&
      host.credentialRepositories.length <= 12, 'MANAGED_CREDENTIAL_AUTHORITY_INVALID');
    const actor = await reader.get('/user');
    requireThat(actor?.id === host.memberId && actor.type === 'User' &&
      /^[A-Za-z0-9-]{1,100}$/.test(actor.login ?? ''),
    'MANAGED_CREDENTIAL_MEMBER_MISMATCH');
    for (const identity of host.credentialRepositories) {
      requireThat(identity && isId(identity.repositoryId),
        'MANAGED_CREDENTIAL_REPOSITORY_MISMATCH');
      let root;
      try { root = repoPath(identity.repository); }
      catch { requireThat(false, 'MANAGED_CREDENTIAL_REPOSITORY_MISMATCH'); }
      const repo = await reader.get(root);
      requireThat(isId(identity.repositoryId) && repo?.id === identity.repositoryId &&
        repo.full_name === identity.repository && repo.archived === false &&
        repo.disabled === false, 'MANAGED_CREDENTIAL_REPOSITORY_MISMATCH');
      const permission = await reader.get(
        `${root}/collaborators/${actor.login}/permission`);
      requireThat(permission?.user?.id === host.memberId &&
        permission.permission === 'admin', 'MANAGED_CREDENTIAL_ADMIN_REQUIRED');
    }
  } catch (error) {
    const known = new Set([
      'MANAGED_CREDENTIAL_AUTHORITY_INVALID', 'MANAGED_CREDENTIAL_MEMBER_MISMATCH',
      'MANAGED_CREDENTIAL_REPOSITORY_MISMATCH', 'MANAGED_CREDENTIAL_ADMIN_REQUIRED',
    ]);
    const code = known.has(error.code) ? error.code : error.status === 401
      ? 'MANAGED_CREDENTIAL_UNAUTHORIZED' : 'MANAGED_CREDENTIAL_PROVIDER_UNAVAILABLE';
    throw Object.assign(new Error(code), { code });
  }
}
