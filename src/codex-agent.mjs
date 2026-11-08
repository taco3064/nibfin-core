import { CandidateWorkspace } from './workspace.mjs';
import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readSkill, skillIdentity } from './skills.mjs';
import { codexPlan } from './codex-plan.mjs';
import { parseAgentResult } from './agent-result.mjs';
import { RoleSessions } from './role-sessions.mjs';
import { subscriptionSecrets, containsCredentials } from './credential-output.mjs';
import { digest, isDigest, requireThat } from './identity.mjs';

// A role adapter, not a sandbox implementation. Only the installed launcher may
// supply the code-owned isolator. No external request may load an adapter/module.
export class CodexRoleAgent {
  #config; #isolator; #sessions; #prepareMain;
  constructor(config, isolator, { prepareMain = async (root, issue, head) => {
    await mkdir(root, { mode: 0o700 });
    return new CandidateWorkspace(root, issue).prepare(head);
  } } = {}) {
    requireThat(config && typeof config.model === 'string' && config.skills &&
      typeof isolator?.execute === 'function', 'INVALID_AGENT_ADAPTER');
    this.#config = structuredClone(config); this.#isolator = isolator;
    this.#sessions = new RoleSessions(config.stateRoot); this.#prepareMain = prepareMain;
  }
  async run(stage, context) {
    const config = this.#config, root = resolve(config.stateRoot);
    const auth = resolve(config.authFile);
    const rootStat = await lstat(root);
    requireThat(rootStat.isDirectory() && rootStat.uid === process.getuid() &&
      (rootStat.mode & 0o077) === 0 &&
      await realpath(root) === root, 'UNTRUSTED_AGENT_STATE');
    requireThat(await realpath(auth) === auth, 'UNTRUSTED_AGENT_AUTH_PATH');
    const work = resolve(config.work);
    requireThat(await realpath(work) === work && (await lstat(work)).isDirectory() &&
      [root, auth, resolve(config.coreRoot)].every(path => path !== work &&
        !path.startsWith(`${work}/`) && !work.startsWith(`${path}/`)),
    'OVERLAPPING_AGENT_AUTHORITY_PATHS');
    const credential = await open(auth, constants.O_RDONLY | constants.O_NOFOLLOW);
    let secrets;
    try {
      const stat = await credential.stat();
      requireThat(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 &&
        (stat.mode & 0o077) === 0 && stat.size < 128 * 1024,
        'UNTRUSTED_AGENT_AUTH_FILE');
      secrets = subscriptionSecrets(JSON.parse(await credential.readFile('utf8')));
    } finally { await credential.close(); }
    const skill = await readSkill(config.coreRoot, stage,
      config.skills[skillIdentity(stage)]);
    return this.#sessions.run(stage, context, async session => {
      const plan = codexPlan(stage, { model: config.model,
        threadId: session.threadId, skill, context });
      const io = join(root, `execution-${context.execution.id}`);
      await mkdir(io, { mode: 0o700 });
      const main = await this.#prepareMain(join(io, 'current-main'),
        context.approval.record.issue, context.main.head);
      requireThat(main.base === context.main.head, 'AGENT_MAIN_SNAPSHOT_CHANGED');
      const input = join(io, 'input'), output = join(io, 'output');
      await mkdir(input, { mode: 0o700 }); await mkdir(output, { mode: 0o700 });
      await writeFile(join(input, 'result-schema.json'), JSON.stringify(plan.schema),
        { flag: 'wx', mode: 0o400 });
      await writeFile(join(input, 'context.json'), JSON.stringify(context),
        { flag: 'wx', mode: 0o400 });
      await writeFile(join(input, 'SKILL.md'), skill.content,
        { flag: 'wx', mode: 0o400 });
      // The isolator must inspect actual mounts/network/policy, probe denial of
      // authentication/session/output reads, and confirm full container cleanup.
      // An unsupported or absent probe cannot be replaced by a config hash.
      const execution = await this.#isolator.execute({ plan,
        executionId: context.execution.id, work: config.work, main: main.directory,
        input, output, session: session.directory, auth });
      requireThat(execution?.status === 'completed' &&
        execution.executionId === context.execution.id &&
        isDigest(execution.terminationHash) && execution.policyHash === plan.policyHash &&
        isDigest(execution.isolationHash) && isDigest(execution.probeHash),
      'AGENT_ISOLATION_OR_TERMINATION_UNPROVEN');
      requireThat(typeof execution.stdout === 'string' &&
        typeof execution.stderr === 'string' &&
        !containsCredentials(execution.stdout, secrets) &&
        !containsCredentials(execution.stderr, secrets), 'CREDENTIAL_OUTPUT_REJECTED');
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
      const parsed = parseAgentResult(stage, execution.stdout, lastMessage,
        session.threadId);
      // Both MCP and model credential scans precede Job-copy retirement.
      await execution.retireMcp?.();
      return { executionId: context.execution.id,
        terminationHash: execution.terminationHash,
        stdout: execution.stdout, lastMessage, expectedThread: session.threadId,
        threadId: parsed.threadId,
        isolationHash: execution.isolationHash, probeHash: execution.probeHash,
        invocationHash: digest({ policyHash: plan.policyHash, skillHash: skill.hash,
          stage, executionId: context.execution.id }) };
    });
  }
}
