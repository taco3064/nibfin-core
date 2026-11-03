import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubReader, repoPath } from './github-read.mjs';
import { readRunnerBinding } from './runner-binding.mjs';
import { readProtectedApproval } from './github-approval.mjs';
import { actionsCaller } from './actions-identity.mjs';
import { readCurrentMain } from './current-main.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { codexStageExecutor } from './codex-stage.mjs';
import { CandidateWorkspace } from './workspace.mjs';
import { command } from './process.mjs';
import { stages } from './stages.mjs';
import { digest, isId, requireThat } from './identity.mjs';
import { acquireHostFence, privateHostDirectory } from './host-fence.mjs';

const hostFile = '/etc/nibfin/host.json';
const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Administrative adoption is deliberately outside a workflow/event's authority.
// Every ancestor is root-owned and non-writable by the Runner account.
export async function rootOwnedPath(path) {
  requireThat(isAbsolute(path) && resolve(path) === path && await realpath(path) === path, 'UNTRUSTED_ADOPTION_PATH');
  for (let current = path; ; current = dirname(current)) {
    const stat = await lstat(current);
    requireThat(!stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0, 'UNTRUSTED_ADOPTION_PATH');
    if (current === '/') break;
  }
}

async function boundedFile(path, limit, privateFile = false) {
  requireThat(isAbsolute(path) && await realpath(path) === path, 'UNTRUSTED_HOST_FILE');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    requireThat(stat.isFile() && stat.nlink === 1 && stat.size <= limit &&
      (!privateFile || stat.uid === process.getuid() && (stat.mode & 0o077) === 0), 'UNTRUSTED_HOST_FILE');
    const bytes = await file.readFile('utf8');
    requireThat(Buffer.byteLength(bytes) <= limit, 'HOST_FILE_TOO_LARGE');
    return bytes;
  } finally { await file.close(); }
}

// Environment identifies candidates to read. Native job and signed OIDC checks
// below authenticate them; environment values never supply approval or a pin.
export async function resolveHostJob(reader, adopted, env) {
  const runner = structuredClone(adopted.runner);
  const runId = Number(env.GITHUB_RUN_ID), attempt = Number(env.GITHUB_RUN_ATTEMPT);
  requireThat(isId(runId) && isId(attempt) && env.GITHUB_REPOSITORY === runner.repository &&
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.RUNNER_ENVIRONMENT === 'self-hosted', 'INVALID_HOST_CALLER');
  const jobs = await reader.list(`${repoPath(runner.repository)}/actions/runs/${runId}/attempts/${attempt}/jobs`, 'jobs');
  const matches = jobs.filter(job => job.name === runner.jobName && job.runner_id === runner.runnerId &&
    job.runner_name === runner.runnerName && job.status === 'in_progress');
  requireThat(matches.length === 1, 'HOST_JOB_NOT_UNIQUE');
  const run = await reader.get(`${repoPath(runner.repository)}/actions/runs/${runId}`);
  Object.assign(runner, { runId, attempt, jobId: matches[0].id, actorId: run.actor?.id });
  const binding = await readRunnerBinding(reader, runner);
  return { runner, binding };
}

export async function readSingleHost(reader, runner) {
  const registered = await reader.list(`${repoPath(runner.repository)}/actions/runners`, 'runners');
  const label = `nibfin-user-${runner.memberId}`;
  const matches = registered.filter(item => Array.isArray(item.labels) && item.labels.some(value => value.name === label));
  requireThat(matches.length === 1 && matches[0].id === runner.runnerId && matches[0].name === runner.runnerName &&
    matches[0].status === 'online' && matches[0].busy === true, 'HOST_REGISTRATION_NOT_EXCLUSIVE');
  return digest(matches);
}

export function hostExecution(runner, stage) {
  const native = { repositoryId: runner.repositoryId, runId: runner.runId, attempt: runner.attempt,
    jobId: runner.jobId, memberId: runner.memberId, sourceCommit: runner.sourceCommit, stage };
  const uuid = kind => {
    const hash = digest({ kind, native });
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  };
  return { id: uuid('execution'), sessionId: uuid('session'), role: stages[stage].role,
    actorId: runner.memberId, runId: runner.runId, attempt: runner.attempt, jobId: runner.jobId };
}

async function idleContainers(profile) {
  const c = profile.agent;
  requireThat(c.docker === profile.hooks.docker && c.socket === profile.hooks.socket, 'SPLIT_HOST_DAEMON');
  const result = await command(c.docker, ['--host', `unix://${c.socket}`, 'ps', '--all', '--no-trunc', '--format', '{{.ID}}'], {
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent' }, limit: 65536 });
  const ids = result.stdout.toString().trim().split('\n').filter(Boolean).sort();
  requireThat(ids.length === 1 && ids[0] === c.gatewayId, 'PREVIOUS_HOST_PROCESS_UNRESOLVED');
  return digest(ids);
}

// Fixed CLI path: no config flag, environment override, adapter module, shell
// command, credential or execution identity can be provided by a request.
export async function launchStage(issueNumber, stage, env = process.env) {
  requireThat(/^[1-9][0-9]*$/.test(issueNumber) && isId(Number(issueNumber)) &&
    typeof stage === 'string' && Object.hasOwn(stages, stage), 'INVALID_STAGE_REQUEST');
  requireThat(process.platform === 'linux' && process.getuid() > 0, 'UNSUPPORTED_STAGE_HOST');
  await rootOwnedPath(hostFile); await rootOwnedPath(coreRoot);
  const hostBytes = await boundedFile(hostFile, 256 * 1024), host = JSON.parse(hostBytes);
  requireThat(host.schemaVersion === 1 && host.uid === process.getuid() && host.installation?.directory === coreRoot &&
    host.kind === 'single-host-linux-v1', 'INVALID_HOST_ADOPTION');
  const adopted = host.issues?.[issueNumber];
  requireThat(adopted && adopted.isolation?.issue?.number === Number(issueNumber) &&
    adopted.runner?.runnerId === host.runnerId && adopted.runner?.memberId === host.memberId, 'ISSUE_NOT_ADOPTED');
  const source = await verifyInstalledSource(coreRoot, host.installation.pin);
  requireThat(digest(source) === digest(adopted.approval.source), 'ADOPTED_SOURCE_MISMATCH');
  await privateHostDirectory(host.stateRoot);
  await privateHostDirectory(dirname(host.tokenFile));
  const token = (await boundedFile(host.tokenFile, 16384, true)).trim();
  const reader = new GitHubReader(token);
  const { runner, binding } = await resolveHostJob(reader, adopted, env);
  const execution = hostExecution(runner, stage);
  const caller = { pin: adopted.caller, requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL,
    requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN };
  await actionsCaller({ ...caller, executionId: execution.id })(binding);
  const approval = await readProtectedApproval(reader, adopted.approval, Date.now());
  requireThat(approval.record.issue.number === Number(issueNumber) && approval.record.issue.id === adopted.isolation.issue.id &&
    approval.record.roles[execution.role] === runner.memberId, 'HOST_APPROVAL_MISMATCH');
  // Stable host-wide lock survives cancellation/kill. No automatic stale-lock
  // deletion or switch to another Runner after an uncertain previous execution.
  let fence;
  try { fence = await acquireHostFence(host.stateRoot, { execution, host: digest(hostBytes) }); }
  catch (error) {
    if (error.code === 'HOST_EXECUTION_UNRESOLVED') return { schemaVersion: 1, stage, status: 'pending', code: error.code };
    throw error;
  }
  try {
    const inspectWriter = async () => {
      requireThat(await boundedFile(hostFile, 256 * 1024) === hostBytes, 'HOST_ADOPTION_CHANGED');
      return { executionId: execution.id, writerStatus: 'exclusive',
        observationHash: digest({ fence: await fence.inspect(), containers: await idleContainers(adopted.isolation),
          registration: await readSingleHost(reader, runner) }) };
    };
    await inspectWriter();
    const root = join(host.stateRoot, `issue-${adopted.runner.repositoryId}-${issueNumber}`);
    await mkdir(root, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await privateHostDirectory(root);
    for (const name of ['receipts', 'agent']) {
      await mkdir(join(root, name), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      await privateHostDirectory(join(root, name));
    }
    const workspaceRoot = join(root, 'workspace');
    let fresh = false;
    try { await mkdir(workspaceRoot, { mode: 0o700 }); fresh = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await privateHostDirectory(workspaceRoot);
    if (fresh) {
      const main = await readCurrentMain(reader, approval.record.issue);
      await new CandidateWorkspace(workspaceRoot, approval.record.issue).prepare(main.head);
    }
    const executor = await codexStageExecutor({ installation: host.installation, caller,
      config: { approval: adopted.approval, runner, stateRoot: join(root, 'receipts'),
        ciWorkflows: adopted.ciWorkflows, reviewers: adopted.reviewers }, execution,
      workspaceRoot, agentStateRoot: join(root, 'agent'), authFile: host.authFile,
      model: host.model, isolation: adopted.isolation, inspectWriter, token });
    const result = await executor.run({ schemaVersion: 1, stage });
    if (result.status !== 'pending') { await inspectWriter(); await fence.release(); }
    return result;
  } catch {
    // Do not turn partial preparation or an unknown container/write into a retry.
    return { schemaVersion: 1, stage, status: 'pending', code: 'HOST_EXECUTION_UNRESOLVED' };
  }
}
