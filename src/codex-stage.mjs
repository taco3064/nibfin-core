import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { installedStageExecutor } from './installed-stage.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { CodexRoleAgent } from './codex-agent.mjs';
import { codexEnvironment } from './codex-environment.mjs';
import { CandidateWorkspace } from './workspace.mjs';
import { digest, requireThat } from './identity.mjs';
import { withUserMcp } from './mcp-agent.mjs';
import { loadUserMcp } from './mcp-source.mjs';
import { runJobVmWriter } from './job-vm-writer.mjs';
import { preflightJobVm } from './job-vm.mjs';
import { issueContainerLabel } from './host-containers.mjs';
import { GitHubReader } from './github-read.mjs';
import { command } from './process.mjs';
import { claudeCredentialReader } from './claude-composition.mjs';

// Fixed composition for the provisional Codex adapter. The privileged launcher
// supplies adopted paths and native writer proof. No request can import a host
// module, choose a command or replace a credential/source verification function.
// This factory does not install Docker or advertise an unverified host profile.
export async function codexStageExecutor({
  installation,
  caller,
  config,
  execution,
  settlement,
  workspaceRoot,
  workflowNodeId,
  project,
  projectRoot,
  toolEnvironment,
  agentStateRoot,
  authFile,
  mcpSource,
  mcpJob,
  jobVm,
  proposal,
  globalInstructions,
  model,
  isolation,
  inspectWriter,
  observeResult,
  token,
  provider,
  credentialKind,
  fetcher = fetch,
  clock = Date.now,
}) {
  const installed = structuredClone(installation),
    adopted = structuredClone(config);
  const actor = structuredClone(execution),
    profile = structuredClone(isolation);
  requireThat(typeof inspectWriter === 'function', 'SUPPORTED_HOST_PROOF_REQUIRED');
  // Only the adopted binding names a provider (installed-provider.mjs); absent
  // means Codex. Claude has no user MCP route and reads one bound credential.
  requireThat(provider === undefined || provider === 'claude',
    'PROVIDER_COMPOSITION_UNAVAILABLE');
  const claude = provider === 'claude';
  requireThat(!claude || (mcpSource === undefined && !mcpJob),
    'CLAUDE_MCP_UNSUPPORTED');
  const readCredential = claude ? claudeCredentialReader(credentialKind) : undefined;
  const writerVm = Boolean(jobVm) && actor.role === 'writer';
  const coreRoot = resolve(installed.directory);
  await verifyInstalledSource(coreRoot, installed.pin);
  // Capture under the verified composition's existing source lifetime.
  const executorSnapshot = writerVm
    ? await readFile(join(coreRoot, 'src/security/job-vm-executor.py')) : undefined;
  // Do not permit separately configured executable/Skill trees: all runtime
  // files used by this adapter must come from the verified installation.
  const skills = {};
  for (const name of ['shape', 'deliver', 'accept']) {
    skills[name] = digest(
      await readFile(join(coreRoot, 'skills', name, 'SKILL.md'), 'utf8'),
    );
  }
  const workspace = new CandidateWorkspace(workspaceRoot, profile.issue, {
    run: async (...args) => {
      const complete = settlement?.enter('workspace command');
      const result = await command(...args);
      // A rejected transport can return before its host process is gone.
      // Leave that invocation unresolved rather than inferring termination.
      complete?.();
      return result;
    },
  });
  const target = adopted.runner.target ?? adopted.runner;
  requireThat(
    profile.issue.id === adopted.approval.issueId &&
      profile.issue.repositoryId === target.repositoryId &&
      profile.issue.repository === target.repository,
    'HOST_WORKSPACE_SUBJECT_CHANGED',
  );
  const environment = await codexEnvironment(
    profile,
    coreRoot,
    adopted.runner,
    project,
    { toolEnvironment, ...(claude ? { provider } : {}) },
  );
  const { agent: agentSandbox, hooks: hookSandbox, image } = environment;
  if (actor.role === 'writer')
    console.error(`Nibfin Writer backend: ${jobVm ? 'firecracker' : 'docker'}`);
  // The adopted provider selects the guest route; Codex keeps the default.
  const vmOptions = claude ? [{ provider }] : [];
  const writer = writerVm ? {
    async preflight(...args) {
      await preflightJobVm(jobVm);
      return agentSandbox.preflight(...args);
    },
    execute: input => runJobVmWriter(jobVm, { ...input,
      executorSnapshot: Buffer.from(executorSnapshot),
      ...(Object.keys(project?.tools ?? {}).length ? { tools: {
        image, endpoint: profile.agent, label: issueContainerLabel(profile.issue),
      } } : {}),
    },
      options => agentSandbox.execute(options), ...vmOptions),
  } : agentSandbox;
  const inheritedAgent = claude ? writer : withUserMcp(writer, mcpSource,
    source => mcpJob ? mcpJob.read() : loadUserMcp(source, {
      discoveryRoot: agentStateRoot, memberId: adopted.runner.memberId,
    }), mcpJob);
  // Claude's credential never becomes a file: no authFile, and the VM-mode plan
  // only for the Firecracker writer (the sandbox requires that equality).
  const providerConfig = claude ? { provider, jobVm: writerVm } : { authFile };
  const roleAgent = new CodexRoleAgent(
    {
      stateRoot: agentStateRoot,
      reportRoot: config.stateRoot,
      ...providerConfig,
      model,
      proposal,
      globalInstructions,
      skills,
      coreRoot,
      work: workspace.work,
      project,
      projectRoot,
    },
    inheritedAgent,
    { settlement, upstream: {
      core: installed.pin, reader: new GitHubReader(token, fetcher),
    }, ...(claude ? { readCredential } : {}) },
  );
  const agent = {
    async run(stage, context) {
      await workspace.clearIgnoredDependencies(context.shape?.body);
      const comparisonBase = stage === 'deliver'
        ? context.rebase?.latestMain ?? await workspace.comparisonBase() : undefined;
      return roleAgent.run(stage, context, comparisonBase);
    },
  };
  const inspectIsolation = async (stage, context) => {
    const writer = await inspectWriter(stage, context);
    requireThat(
      writer?.executionId === actor.id &&
        writer.writerStatus === 'exclusive' &&
        /^[a-f0-9]{64}$/.test(writer.observationHash),
      'WRITER_EXCLUSIVITY_UNPROVEN',
    );
    const agentProof = await inheritedAgent.preflight(),
      hookProof = await hookSandbox.preflight();
    return {
      profile: profile.kind,
      executionId: actor.id,
      writerStatus: 'exclusive',
      observationHash: digest({
        writer,
        agent: agentProof.observationHash,
        hooks: hookProof.observationHash,
      }),
    };
  };
  const executor = await installedStageExecutor({
    installation: installed,
    caller,
    config: adopted,
    execution: actor,
    agent,
    workspace,
    workflowNodeId,
    sandbox: hookSandbox,
    inspectIsolation,
    observeResult,
    token,
    fetcher,
    clock,
  });
  settlement?.composed();
  return executor;
}
