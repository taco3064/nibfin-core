import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { installedStageExecutor } from './installed-stage.mjs';
import { verifyInstalledSource } from './source-package.mjs';
import { CodexRoleAgent } from './codex-agent.mjs';
import { codexEnvironment } from './codex-environment.mjs';
import { CandidateWorkspace } from './workspace.mjs';
import { digest, requireThat } from './identity.mjs';

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
  agentStateRoot,
  authFile,
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
  requireThat(
    profile.issue.id === adopted.approval.issueId &&
      profile.issue.repositoryId === adopted.runner.repositoryId &&
      profile.issue.repository === adopted.runner.repository,
    'HOST_WORKSPACE_SUBJECT_CHANGED',
  );
  const { agent: agentSandbox, hooks: hookSandbox } = codexEnvironment(
    profile,
    coreRoot,
  );
  const agent = new CodexRoleAgent(
    {
      stateRoot: agentStateRoot,
      authFile,
      model,
      skills,
      coreRoot,
      work: workspace.work,
    },
    agentSandbox,
  );
  const inspectIsolation = async (stage, context) => {
    const writer = await inspectWriter(stage, context);
    requireThat(
      writer?.executionId === actor.id &&
        writer.writerStatus === 'exclusive' &&
        /^[a-f0-9]{64}$/.test(writer.observationHash),
      'WRITER_EXCLUSIVITY_UNPROVEN',
    );
    const agentProof = await agentSandbox.preflight(),
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
