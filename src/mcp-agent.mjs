import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { loadUserMcp } from './mcp-source.mjs';
import { containsCredentials } from './credential-output.mjs';
import { requireThat, digest } from './identity.mjs';

async function checkPrivateResult(path, secrets) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    requireThat(stat.isFile() && stat.nlink === 1 && stat.size <= 1024 * 1024,
      'UNSAFE_AGENT_RESULT');
    requireThat(!containsCredentials(await file.readFile('utf8'), secrets),
      'MCP_CREDENTIAL_OUTPUT_REJECTED');
  } finally { await file.close(); }
}

// The composition supplies the source. A role's context cannot select or mutate
// its MCP profile. Unrelated user settings/hooks are never loaded into the role.
export function withUserMcp(isolator, source, readProfile = loadUserMcp, job) {
  if (source === undefined) return isolator;
  let prepared;
  const prepare = () => prepared ??= readProfile(source);
  const fresh = mcp => requireThat(mcp.expiresAt === null ||
    mcp.expiresAt > Date.now() + 30 * 60 * 1000,
  'USER_MCP_AUTHENTICATION_REFRESH_REQUIRED');
  return {
    async preflight(...args) {
      const mcp = await prepare();
      fresh(mcp);
      const proof = await isolator.preflight(...args);
      return { ...proof, observationHash: digest({
        isolation: proof.observationHash, mcpPolicyHash: mcp.policyHash,
      }) };
    },
    async execute(input) {
      const mcp = await prepare();
      fresh(mcp);
      const plan = {
        ...input.plan, mcpPolicyHash: mcp.policyHash,
        args: input.plan.args.filter(arg => arg !== '--ignore-user-config'),
        prompt: input.plan.prompt + '\nTRUSTED MCP AVAILABILITY:\n' +
          JSON.stringify({
            ...mcp.metadata,
            tools: Object.fromEntries(Object.entries(mcp.configuration.mcp_servers)
              .filter(([, server]) => server.enabled !== false)
              .map(([name, server]) => [name, server.enabled_tools ?? []])),
          }) +
          '\nUse the listed MCP tools to read approved sources. Resource listings ' +
          'do not enumerate tools. Discover deferred tools before concluding that ' +
          'a page-fetch tool is unavailable. Report the actual call failure.',
      };
      const finish = job?.enter();
      let proved = false, deferred = false;
      try {
        const result = await isolator.execute({ ...input, plan, mcp });
        if (result.status === 'completed') {
          requireThat(
            !containsCredentials(result.stdout, mcp.secrets) &&
              !containsCredentials(result.stderr, mcp.secrets),
            'MCP_CREDENTIAL_OUTPUT_REJECTED',
          );
          await checkPrivateResult(join(input.output, 'result.json'), mcp.secrets);
          const retire = result.retireMcp;
          if (job) {
            // The role adapter scans model credentials and the final message.
            // Keep this consumer active until those checks also finish.
            result.retireMcp = async () => {
              try {
                await retire?.();
                proved = /^[a-f0-9]{64}$/.test(result.terminationHash);
              } finally { finish(proved); }
            };
            deferred = true;
          } else await retire?.();
        }
        return result;
      } finally { if (!deferred) finish?.(proved); }
    },
  };
}
