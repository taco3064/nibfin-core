import { scanInterruptedOutput } from './interrupted-output.mjs';
import { pressureBinding } from './host-memory-pressure.mjs';
import { makeBlockerReport } from './blocker-report.mjs';
import { saveBlockerReport } from './blocker-report-store.mjs';
import { requireModelTermination } from './provider-contract.mjs';
import { CandidateWorkspace } from './workspace.mjs';
import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readEffectiveSkill, skillIdentity } from './skills.mjs';
import { codexPlan } from './codex-plan.mjs';
import { claudeAgentPlan } from './claude-agent-plan.mjs';
import { parseClaudeResult } from './claude-result.mjs';
import { readClaudeCredential } from './claude-model-credentials.mjs';
import { parseAgentResult } from './agent-result.mjs';
import { RoleSessions } from './role-sessions.mjs';
import { subscriptionSecrets, containsCredentials } from './credential-output.mjs';
import { digest, requireThat } from './identity.mjs';
import { prepareRoleUpstream } from './role-upstream.mjs';
import { discardRoleSources } from './role-source-cleanup.mjs';

// A role adapter, not a sandbox implementation. Only the installed launcher may
// supply the code-owned isolator. No external request may load an adapter/module.
export class CodexRoleAgent {
  #config; #isolator; #sessions; #prepareMain; #upstream; #settlement;
  #readCredential;
  constructor(config, isolator, { prepareMain = async (root, issue, head) => {
    await mkdir(root, { mode: 0o700 });
    return new CandidateWorkspace(root, issue).prepare(head);
  }, upstream, reclaim, settlement, readCredential = readClaudeCredential } = {}) {
    requireThat(config && typeof config.model === 'string' && config.skills &&
      [undefined, 'codex', 'claude'].includes(config.provider) &&
      typeof isolator?.execute === 'function', 'INVALID_AGENT_ADAPTER');
    this.#config = structuredClone(config); this.#isolator = isolator;
    this.#sessions = new RoleSessions(config.stateRoot, reclaim);
    this.#prepareMain = prepareMain;
    this.#upstream = upstream;
    this.#settlement = settlement;
    this.#readCredential = readCredential;
  }
  async run(stage, context, comparisonBase = context.main.head) {
    this.#settlement?.assertExecution(context.execution);
    const retireRole = this.#settlement?.enter('role');
    const config = this.#config, root = resolve(config.stateRoot);
    // Claude's one stored credential is read by Core and never becomes a file.
    const claude = config.provider === 'claude';
    const auth = claude ? undefined : resolve(config.authFile);
    const rootStat = await lstat(root);
    requireThat(rootStat.isDirectory() && rootStat.uid === process.getuid() &&
      (rootStat.mode & 0o077) === 0 &&
      await realpath(root) === root, 'UNTRUSTED_AGENT_STATE');
    if (!claude)
      requireThat(await realpath(auth) === auth, 'UNTRUSTED_AGENT_AUTH_PATH');
    const work = resolve(config.work);
    requireThat(await realpath(work) === work && (await lstat(work)).isDirectory() &&
      [root, ...(claude ? [] : [auth]), resolve(config.coreRoot)].every(path =>
        path !== work && !path.startsWith(`${work}/`) && !work.startsWith(`${path}/`)),
    'OVERLAPPING_AGENT_AUTHORITY_PATHS');
    let secrets, credential;
    if (claude) {
      credential = await this.#readCredential().catch(() => {
        throw new Error('CLAUDE_CREDENTIAL_UNAVAILABLE');
      });
      secrets = [credential];
    } else secrets = await codexSecrets(auth);
    const skill = await readEffectiveSkill(config.coreRoot, stage,
      config.skills[skillIdentity(stage)], config.project, config.projectRoot);
    const result = await this.#sessions.run(stage, context, async session => {
      const plan = (claude ? claudeAgentPlan : codexPlan)(stage, { model: config.model,
        threadId: session.threadId, skill, context,
        hasProposal: Boolean(config.proposal),
        additionalDomains: config.project?.allowedDomains,
        projectTools: config.project?.tools,
        globalInstructions: config.globalInstructions,
        // Claude only: the Firecracker writer selects its VM-mode plan.
        ...(claude ? { jobVm: config.jobVm === true } : {}) });
      const io = join(root, `execution-${context.execution.id}`);
      await mkdir(io, { mode: 0o700 });
      const main = await this.#prepareMain(join(io, 'current-main'),
        context.approval.record.issue, comparisonBase);
      requireThat(main.base === comparisonBase, 'AGENT_MAIN_SNAPSHOT_CHANGED');
      const input = join(io, 'input'), output = join(io, 'output');
      await mkdir(input, { mode: 0o700 }); await mkdir(output, { mode: 0o700 });
      if (this.#upstream) await prepareRoleUpstream({
        ...this.#upstream, context, io, input, prepare: this.#prepareMain,
      });
      await writeFile(join(input, 'result-schema.json'), JSON.stringify(plan.schema),
        { flag: 'wx', mode: 0o400 });
      await writeFile(join(input, 'context.json'), JSON.stringify(context),
        { flag: 'wx', mode: 0o400 });
      if (config.proposal) {
        await writeFile(join(input, 'proposal.md'), config.proposal.markdown,
          { flag: 'wx', mode: 0o400 });
      }
      await writeFile(join(input, 'SKILL.md'), skill.content,
        { flag: 'wx', mode: 0o400 });
      // The isolator must inspect actual mounts/network/policy, probe denial of
      // authentication/session/output reads, and confirm full container cleanup.
      // An unsupported or absent probe cannot be replaced by a config hash.
      const handback = this.#settlement?.enter('backend/workspace');
      const execution = await this.#isolator.execute({ plan,
        onLocalHandback: handback,
        settlement: this.#settlement,
        pressureBinding: pressureBinding(stage, context),
        executionId: context.execution.id, work: config.work, main: main.directory,
        input, output, session: session.directory, auth,
        ...(claude ? { credential } : {}),
        onTermination: config.reportRoot ? async termination => {
          await saveBlockerReport(config.reportRoot,
            makeBlockerReport(context, stage, { producer: 'core-native',
              termination }));
        } : undefined });
      requireModelTermination(execution, context.execution.id, plan.policyHash);
      if (execution.status === 'interrupted') {
        await scanInterruptedOutput(output, secrets, 'CREDENTIAL_OUTPUT_REJECTED');
        await discardRoleSources(io, false);
        return execution;
      }
      requireThat(typeof execution.stdout === 'string' &&
        typeof execution.stderr === 'string' &&
        !containsCredentials(execution.stdout, secrets) &&
        !containsCredentials(execution.stderr, secrets), 'CREDENTIAL_OUTPUT_REJECTED');
      // Claude's bootstrap returns only its validated terminal result envelope.
      const lastMessage = claude ? undefined : await codexLastMessage(output, secrets);
      const parsed = claude ? parseClaudeResult(stage, execution.stdout) :
        parseAgentResult(stage, execution.stdout, lastMessage, session.threadId);
      // Both MCP and model credential scans precede Job-copy retirement.
      await execution.retireMcp?.();
      await execution.applyWorkspace?.();
      handback?.();
      // RoleSessions aggregates source and private-home retirement in one request.
      await discardRoleSources(io, false);
      return { executionId: context.execution.id,
        terminationHash: execution.terminationHash,
        terminationObservation: execution.terminationObservation,
        stdout: execution.stdout, ...(claude ? {} : { lastMessage }),
        expectedThread: session.threadId,
        threadId: parsed.threadId,
        isolationHash: execution.isolationHash, probeHash: execution.probeHash,
        invocationHash: digest({ policyHash: plan.policyHash, skillHash: skill.hash,
          stage, executionId: context.execution.id,
          proposalHash: config.proposal?.hash ?? null }),
        // Provider-neutral result; stage handlers adopt it with the composition.
        result: parsed.result };
    });
    retireRole?.();
    return result;
  }
}

async function codexSecrets(auth) {
  const credential = await open(auth, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await credential.stat();
    requireThat(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 &&
      (stat.mode & 0o077) === 0 && stat.size < 128 * 1024,
      'UNTRUSTED_AGENT_AUTH_FILE');
    return subscriptionSecrets(JSON.parse(await credential.readFile('utf8')));
  } finally { await credential.close(); }
}

async function codexLastMessage(output, secrets) {
  const resultPath = join(output, 'result.json');
  requireThat(await realpath(resultPath) === resultPath, 'UNSAFE_AGENT_RESULT');
  const file = await open(resultPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let lastMessage;
  try {
    const stat = await file.stat();
    requireThat(stat.isFile() && stat.nlink === 1 && stat.size <= 1024 * 1024,
      'UNSAFE_AGENT_RESULT');
    lastMessage = await file.readFile('utf8');
  } finally { await file.close(); }
  requireThat(!containsCredentials(lastMessage, secrets),
    'CREDENTIAL_OUTPUT_REJECTED');
  return lastMessage;
}
