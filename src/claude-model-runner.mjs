import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { command } from './process.mjs';
import { digest, requireThat } from './identity.mjs';
import { dockerBackend, validDockerEndpoint, verifyDockerSocket, dockerInfo }
  from './docker-backend.mjs';
import { verifyAppArmor } from './apparmor-proof.mjs';
import { ClaudeWorkWorker, withClaudeWorkWorker } from './claude-work-launcher.mjs';
import { claudeWorkChannel, claudeWorkServer } from './claude-work-channel.mjs';
import { verifyWorkEgress } from './claude-work-egress.mjs';
import { inspectModelContainer, modelContainerArgs } from './claude-model-container.mjs';
import { readClaudeApiKey, validClaudeApiKey } from './claude-model-credentials.mjs';

const immutable = /^sha256:[a-f0-9]{64}$/;
export const claudeModelComponent = Object.freeze({
  cli: Object.freeze({ package: '@anthropic-ai/claude-code', version: '2.1.326',
    executable: '/opt/nibfin/claude/bin/claude' }),
  runner: 'claude-private-runner-v1',
  toolChannel: claudeWorkChannel,
  credentialKind: 'anthropic-api-key',
  modelRecipe: 'src/security/claude-model.Dockerfile',
  workerRecipe: 'src/security/claude-work.Dockerfile',
});

export function createClaudePrivateRunner(config, {
  host = { platform: process.platform, uid: process.getuid?.(), lstat, realpath },
  run = command, readKey = readClaudeApiKey, signal, backend,
} = {}) {
  config = structuredClone(config);
  const policy = dockerBackend(backend);
  requireThat(policy.mode === 'rootful' && validDockerEndpoint(config, policy) &&
    immutable.test(config.image) && config.worker && config.modelEgress &&
    config.worker.egress?.network !== config.modelEgress.network,
  'CLAUDE_PRIVATE_PROFILE_UNAVAILABLE');
  const executions = new Map();
  const docker = (args, options = {}) => run(config.docker,
    ['--host', `unix://${config.socket}`, ...args], {
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C.UTF-8',
        DOCKER_CONFIG: '/nonexistent' },
      timeout: 30000, limit: 1048576, ...options,
    });
  const inspect = async args => {
    const rows = JSON.parse((await docker(args)).stdout.toString());
    requireThat(Array.isArray(rows) && rows.length === 1, 'CLAUDE_MODEL_INSPECT_FAILED');
    return rows[0];
  };
  const settle = async record => {
    if (record.stopping) return record.stopping;
    record.stopping = (async () => {
      if (record.possiblyCreated) {
        const remaining = async () => (await docker(['ps', '-aq', '--filter',
          `name=^/${record.name}$`])).stdout.toString().trim();
        const id = await remaining();
        if (id) {
          requireThat(/^[a-f0-9]{12,64}$/.test(id), 'CLAUDE_MODEL_TERMINATION_UNKNOWN');
          await docker(['rm', '--force', record.name]);
        }
        requireThat(!await remaining(), 'CLAUDE_MODEL_TERMINATION_UNKNOWN');
      }
      return digest({ container: record.name, absent: true });
    })();
    try { return await record.stopping; } catch (error) {
      record.stopping = undefined;
      throw error;
    }
  };
  return {
    contract: claudeModelComponent.runner,
    async execute({ plan, executionId, session }) {
      requireThat(!executions.has(executionId) &&
        digest(plan.cli) === digest(claudeModelComponent.cli) &&
        plan.executable === claudeModelComponent.cli.executable &&
        plan.repositoryMounts === false && plan.cleanConfig === true &&
        plan.environment.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB === '1' &&
        plan.args.includes(JSON.stringify({ mcpServers: { work: claudeWorkServer() } })),
      'CLAUDE_MODEL_PLAN_CHANGED');
      const record = { name: `nibfin-claude-model-${randomUUID()}` };
      executions.set(executionId, record);
      await verifyDockerSocket(config.socket, policy, host);
      const info = JSON.parse((await docker(['info', '--format', '{{json .}}']))
        .stdout.toString());
      const daemon = dockerInfo(info, policy);
      const image = await inspect(['image', 'inspect', config.image]);
      requireThat(image.Id === config.image &&
        image.Config?.Labels?.['io.nibfin.claude-version'] === plan.cli.version,
      'CLAUDE_MODEL_IMAGE_UNVERIFIED');
      const inherited = (image.Config.Env ?? []).map(value => value.split('=')[0]);
      requireThat(inherited.every(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)),
        'CLAUDE_MODEL_IMAGE_UNVERIFIED');
      const probeHash = await verifyAppArmor(docker, config.image, policy.namespace);
      const egress = await verifyWorkEgress(config.modelEgress, docker, true);
      const { uidStart, gidStart } = policy.namespace;
      const worker = new ClaudeWorkWorker(config.worker.container, {
        ...config.worker.mounts, session, executionId, stage: plan.contract.stage,
        peer: { uid: uidStart + 1001, gid: gidStart + 1001 },
      }, { run, host, backend: policy, egress: config.worker.egress });
      const result = await withClaudeWorkWorker(worker, async handoff => {
        requireThat(!signal?.aborted, 'CLAUDE_MODEL_INTERRUPTED');
        record.key = await readKey();
        requireThat(validClaudeApiKey(record.key), 'CLAUDE_API_KEY_UNAVAILABLE');
        record.possiblyCreated = true;
        const model = { image: config.image, name: record.name, plan, egress,
          channel: dirname(handoff.socket), inherited };
        const id = (await docker(modelContainerArgs(model))).stdout.toString().trim();
        requireThat(/^[a-f0-9]{64}$/.test(id), 'CLAUDE_MODEL_INSPECT_FAILED');
        const observed = await inspect(['inspect', id]);
        inspectModelContainer(observed, { ...model, id });
        let output, timedOut = false, outputLimitExceeded = false;
        const cancel = () => { void settle(record).catch(() => {}); };
        signal?.addEventListener('abort', cancel, { once: true });
        try {
          if (!signal?.aborted) output = await docker(['start', '-ai', id], {
            input: JSON.stringify({ key: record.key, prompt: plan.prompt }),
            timeout: plan.limits.timeoutMs, limit: plan.limits.stdout + plan.limits.stderr,
            allowedExitCodes: Array.from({ length: 256 }, (_, code) => code),
          });
        } catch (error) {
          timedOut = error.code === 'PROCESS_TIMEOUT';
          outputLimitExceeded = error.code === 'PROCESS_OUTPUT_LIMIT';
          if (!timedOut && !outputLimitExceeded && !signal?.aborted)
            throw new Error('CLAUDE_MODEL_TRANSPORT_UNAVAILABLE');
        } finally {
          signal?.removeEventListener('abort', cancel);
          await settle(record);
        }
        return { stdout: output?.stdout.toString() ?? '',
          stderr: output?.stderr.toString() ?? '', exitCode: output?.exitCode ?? 1,
          timedOut, outputLimitExceeded,
          isolationHash: digest({ daemon, egress: egress.observationHash,
            model: observed, worker: handoff.isolationHash }) };
      });
      const work = worker.requireSettlement();
      return { ...result, status: signal?.aborted ? 'interrupted' : 'completed',
        executionId, probeHash, policyHash: plan.policyHash,
        terminationHash: digest({ model: await settle(record), work }) };
    },
    async requestCleanup(executionId) {
      const record = executions.get(executionId);
      if (record) await settle(record);
    },
    async assertOutputSafe(executionId, stdout, stderr) {
      const key = executions.get(executionId)?.key;
      return !!key && !stdout.includes(key) && !stderr.includes(key);
    },
    async retire(executionId) { executions.delete(executionId); },
  };
}
