import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { command } from './process.mjs';
import { digest, requireThat } from './identity.mjs';
import { dockerBackend, validDockerEndpoint, verifyDockerSocket, dockerInfo }
  from './docker-backend.mjs';
import { verifyAppArmor } from './apparmor-proof.mjs';
import { ClaudeWorkWorker } from './claude-work-launcher.mjs';
import { claudeWorkChannel, claudeWorkServer } from './claude-work-channel.mjs';
import { verifyWorkEgress } from './claude-work-egress.mjs';
import { inspectModelContainer, modelContainerArgs } from './claude-model-container.mjs';
import { claudeCredentialKinds, readClaudeCredential, validClaudeCredential }
  from './claude-model-credentials.mjs';
import { containsCredentials } from './credential-output.mjs';

const immutable = /^sha256:[a-f0-9]{64}$/;
export const claudeModelComponent = Object.freeze({
  cli: Object.freeze({ package: '@anthropic-ai/claude-code', version: '2.1.326',
    executable: '/opt/nibfin/claude/bin/claude' }),
  runner: 'claude-private-runner-v1',
  toolChannel: claudeWorkChannel,
  credentialKinds: Object.freeze(Object.keys(claudeCredentialKinds)),
  managedSettings: 'absent',
  modelRecipe: 'src/security/claude-model.Dockerfile',
  workerRecipe: 'src/security/claude-work.Dockerfile',
});

export function createClaudePrivateRunner(config, {
  host = { platform: process.platform, uid: process.getuid?.(), lstat, realpath },
  run = command, readKey = readClaudeCredential, signal, backend,
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
  const settleModel = async record => {
    try { await record.launch; } catch { /* Reconcile lost create responses. */ }
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
  const settle = async record => {
    record.cancelled = true;
    if (record.cleanup) return record.cleanup;
    record.cleanup = (async () => {
      await record.startup;
      const results = await Promise.allSettled([
        settleModel(record), record.worker?.settle(),
      ]);
      requireThat(results.every(result => result.status === 'fulfilled'),
        'CLAUDE_MODEL_TERMINATION_UNKNOWN');
      const work = record.worker ? record.worker.requireSettlement() : null;
      if (record.worker) await record.worker.dispose();
      record.terminated = true;
      return digest({ model: results[0].value, work });
    })();
    try { return await record.cleanup; }
    catch (error) {
      record.cleanup = undefined;
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
      let prepared;
      const record = { name: `nibfin-claude-model-${randomUUID()}`,
        startup: new Promise(resolve => { prepared = resolve; }) };
      const check = () => requireThat(!record.cancelled && !signal?.aborted,
        'CLAUDE_MODEL_INTERRUPTED');
      const cancel = () => {
        record.cancelled = true;
        void settle(record).catch(() => {});
      };
      signal?.addEventListener('abort', cancel, { once: true });
      executions.set(executionId, record);
      try {
        check();
        await verifyDockerSocket(config.socket, policy, host);
        const info = JSON.parse((await docker(['info', '--format', '{{json .}}']))
          .stdout.toString());
        const daemon = dockerInfo(info, policy);
        const image = await inspect(['image', 'inspect', config.image]);
        requireThat(image.Id === config.image &&
          image.Config?.Labels?.['io.nibfin.claude-version'] === plan.cli.version &&
          image.Config.Labels['io.nibfin.claude-managed-settings'] ===
            claudeModelComponent.managedSettings,
        'CLAUDE_MODEL_IMAGE_UNVERIFIED');
        const inherited = (image.Config.Env ?? []).map(value => value.split('=')[0]);
        requireThat(inherited.every(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)),
          'CLAUDE_MODEL_IMAGE_UNVERIFIED');
        const probeHash = await verifyAppArmor(docker, config.image, policy.namespace);
        const egress = await verifyWorkEgress(config.modelEgress, docker, true);
        const { uidStart, gidStart } = policy.namespace;
        check();
        const worker = record.worker = new ClaudeWorkWorker(config.worker.container, {
          ...config.worker.mounts, session, executionId, stage: plan.contract.stage,
          peer: { uid: uidStart + 1001, gid: gidStart + 1001 },
        }, { run, host, backend: policy, egress: config.worker.egress,
          deferDisposal: true });
        const handoff = await worker.start({ signal });
        prepared();
        check();
        const result = await (async () => {
          check();
          record.key = await readKey();
          requireThat(validClaudeCredential(record.key), 'CLAUDE_CREDENTIAL_UNAVAILABLE');
          check();
          record.possiblyCreated = true;
          const model = { image: config.image, name: record.name, plan, egress,
            channel: dirname(handoff.socket), inherited };
          let observed, output, timedOut = false, outputLimitExceeded = false;
          let monitoring = true, monitorFailure;
          let timer, wake;
          const monitor = (async () => {
            while (monitoring) {
              try { await worker.assertHealthy(); }
              catch {
                if (monitoring) {
                  monitorFailure = true;
                  cancel();
                }
                return;
              }
              if (monitoring) await new Promise(resolve => {
                wake = resolve;
                timer = setTimeout(resolve, 100);
              });
            }
          })();
          try {
            record.launch = docker(modelContainerArgs(model));
            // Settlement waits for a possibly effective create before reconciling.
            const id = (await record.launch).stdout.toString().trim();
            requireThat(/^[a-f0-9]{64}$/.test(id), 'CLAUDE_MODEL_INSPECT_FAILED');
            const inspected = await inspect(['inspect', id]);
            inspectModelContainer(inspected, { ...model, id });
            observed = inspected;
            check();
            output = await docker(['start', '-ai', id], {
              input: JSON.stringify({ key: record.key, prompt: plan.prompt }),
              timeout: plan.limits.timeoutMs,
              limit: plan.limits.stdout + plan.limits.stderr,
              allowedExitCodes: Array.from({ length: 256 }, (_, code) => code),
            });
            if (!record.cancelled) await worker.assertHealthy();
            outputLimitExceeded = output?.stdout.length > plan.limits.stdout ||
              output?.stderr.length > plan.limits.stderr;
          } catch (error) {
            if (!observed) throw error;
            timedOut = error.code === 'PROCESS_TIMEOUT';
            outputLimitExceeded = error.code === 'PROCESS_OUTPUT_LIMIT';
            if (!timedOut && !outputLimitExceeded && !signal?.aborted)
              throw new Error('CLAUDE_MODEL_TRANSPORT_UNAVAILABLE');
          } finally {
            monitoring = false;
            clearTimeout(timer);
            wake?.();
            await monitor;
            await settleModel(record);
          }
          requireThat(!monitorFailure || signal?.aborted, 'CLAUDE_WORK_CHANNEL_FAILED');
          if (!signal?.aborted) {
            requireThat(!record.cancelled, 'CLAUDE_MODEL_INTERRUPTED');
          }
          return { stdout: output?.stdout.toString() ?? '',
            stderr: output?.stderr.toString() ?? '', exitCode: output?.exitCode ?? 1,
            timedOut, outputLimitExceeded,
            isolationHash: digest({ daemon, egress: egress.observationHash,
              model: observed, worker: handoff.isolationHash }) };
        })();
        const terminationHash = await settle(record);
        return { ...result, status: signal?.aborted ? 'interrupted' : 'completed',
          executionId, probeHash, policyHash: plan.policyHash,
          terminationHash };
      } finally {
        prepared();
        signal?.removeEventListener('abort', cancel);
        await settle(record);
      }
    },
    async requestCleanup(executionId) {
      const record = executions.get(executionId);
      if (record) await settle(record);
    },
    async assertOutputSafe(executionId, stdout, stderr) {
      const key = executions.get(executionId)?.key;
      return !!key && !containsCredentials(stdout, [key]) &&
        !containsCredentials(stderr, [key]);
    },
    async retire(executionId) {
      const record = executions.get(executionId);
      requireThat(record?.terminated, 'CLAUDE_MODEL_TERMINATION_UNKNOWN');
      executions.delete(executionId);
    },
  };
}
