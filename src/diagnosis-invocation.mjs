import { mkdir, mkdtemp, rm, writeFile, lstat, realpath } from 'node:fs/promises';
import { dockerBackend, verifyDockerSocket } from './docker-backend.mjs';
import { join } from 'node:path';
import { installedProvider } from './provider-binding.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { codexEnvironment } from './codex-environment.mjs';
import { boundedHostFile } from './host-adoption.mjs';
import { subscriptionSecrets, containsCredentials } from './credential-output.mjs';
import { diagnosisPlan, safeDiagnosisResult } from './diagnosis-plan.mjs';
import { requireThat, isDigest } from './identity.mjs';

// Called after authentication and route authorization, using only installed
// adoption. No target checkout, GitHub token, MCP, session or delivery adapter.
export async function prepareDiagnosisInvocation(host, issue, {
  verify = verifyInstalledSource, environment = codexEnvironment,
  read = boundedHostFile, socket = verifyDockerSocket,
} = {}) {
  const adopted = host.diagnosisHost;
  requireThat(adopted && process.getuid() === host.uid &&
    adopted.uid === host.uid, 'CONTROLLER_ACCESS_REQUIRED');
  const provider = installedProvider(adopted);
  // Diagnosis runs the Codex plan only; a Claude pool has no diagnosis route.
  requireThat(provider.provider !== 'claude', 'CLAUDE_DIAGNOSIS_UNSUPPORTED');
  await verify(adopted.installation.directory, adopted.installation.pin);
  const secrets = subscriptionSecrets(JSON.parse(
    await read(adopted.authFile, 128 * 1024, true)));
  const profile = { ...adopted.repository.isolation, issue };
  await socket(profile.agent.socket, dockerBackend({ kind: profile.kind,
    ...(profile.namespace ? { namespace: profile.namespace } : {}) }),
  { platform: process.platform, uid: process.getuid(), lstat, realpath });
  const runner = adopted.sharedRunner?.runner ?? adopted.repository.runner;
  const sandbox = (await environment(profile, adopted.installation.directory,
    runner)).agent;
  return async ({ invocationId, evidence, directory }) => {
    const root = await mkdtemp(join(directory, 'invocation-'));
    let terminated = false;
    try {
      const paths = {};
      for (const name of ['work', 'main', 'input', 'output', 'session']) {
        paths[name] = join(root, name);
        await mkdir(paths[name], { mode: 0o700 });
      }
      const plan = diagnosisPlan(provider.modelProfile.model, evidence);
      await writeFile(join(paths.input, 'result-schema.json'),
        JSON.stringify(plan.schema), { flag: 'wx', mode: 0o400 });
      const result = await sandbox.execute({ ...paths, plan,
        executionId: invocationId, auth: adopted.authFile });
      terminated = result.executionId === invocationId &&
        isDigest(result.terminationHash) &&
        ['completed', 'interrupted', 'denied'].includes(result.status);
      if (!terminated) return { terminated: false };
      if (result.status !== 'completed') return { terminated: true };
      const message = await read(join(paths.output, 'result.json'), 8192, true);
      requireThat(!containsCredentials(message, secrets), 'CREDENTIAL_OUTPUT_REJECTED');
      return { terminated: true, report: safeDiagnosisResult(JSON.parse(message)) };
    } catch (error) {
      if (terminated) return { terminated: true };
      throw error;
    } finally {
      // Unknown termination retains the mount evidence and the in-flight record.
      if (terminated) await rm(root, { recursive: true, force: true });
    }
  };
}
