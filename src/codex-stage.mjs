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

// Fixed composition for the provisional Codex adapter. The privileged launcher
// supplies adopted paths and native writer proof. No request can import a host
// module, choose a command or replace a credential/source verification function.
// This factory does not install Docker or advertise an unverified host profile.
export async function codexStageExecutor({
  installation,
  caller,
  config,
  execution,
  workspaceRoot,
  project,
  projectRoot,
  agentStateRoot,
  authFile,
  mcpSource,
  mcpJob,
  proposal,
  globalInstructions,
  model,
  isolation,
  inspectWriter,
  token,
  fetcher = fetch,
  clock = Date.now,
}) {
  const installed = structuredClone(installation),
    adopted = structuredClone(config);
  const actor = structuredClone(execution),
    profile = structuredClone(isolation);
  requireThat(typeof inspectWriter === 'function', 'SUPPORTED_HOST_PROOF_REQUIRED');
  const coreRoot = resolve(installed.directory);
  await verifyInstalledSource(coreRoot, installed.pin);
  // Do not permit separately configured executable/Skill trees: all runtime
  // files used by this adapter must come from the verified installation.
  const skills = {};
  for (const name of ['shape', 'deliver', 'accept']) {
    skills[name] = digest(
      await readFile(join(coreRoot, 'skills', name, 'SKILL.md'), 'utf8'),
    );
  }
  const workspace = new CandidateWorkspace(workspaceRoot, profile.issue);
  const target = adopted.runner.target ?? adopted.runner;
  requireThat(
    profile.issue.id === adopted.approval.issueId &&
      profile.issue.repositoryId === target.repositoryId &&
      profile.issue.repository === target.repository,
    'HOST_WORKSPACE_SUBJECT_CHANGED',
  );
  const { agent: agentSandbox, hooks: hookSandbox } = codexEnvironment(
    profile,
    coreRoot,
    adopted.runner,
    project,
  );
  const inheritedAgent = withUserMcp(agentSandbox, mcpSource,
    source => mcpJob ? mcpJob.read() : loadUserMcp(source, {
      discoveryRoot: agentStateRoot, memberId: adopted.runner.memberId,
    }), mcpJob);
  const roleAgent = new CodexRoleAgent(
    {
      stateRoot: agentStateRoot,
      authFile,
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
  );
  const agent = {
    async run(stage, context) {
      await workspace.clearIgnoredDependencies(context.shape?.body);
      return roleAgent.run(stage, context);
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
  return installedStageExecutor({
    installation: installed,
    caller,
    config: adopted,
    execution: actor,
    agent,
    workspace,
    sandbox: hookSandbox,
    inspectIsolation,
    token,
    fetcher,
    clock,
  });
}
