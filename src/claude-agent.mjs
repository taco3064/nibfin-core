import { claudePlan, claudeLimits } from './claude-plan.mjs';
import { parseClaudeResult } from './claude-result.mjs';
import { requireModelTermination } from './provider-contract.mjs';
import { requireThat } from './identity.mjs';
import { RoleSessions } from './role-sessions.mjs';

// Component only; deliberately not installed-provider composition. The trusted
// runner owns authentication, actual isolation, bounded stream collection and
// cleanup. It must not return private configuration through any tool channel.
export class ClaudeRoleAgent {
  #component; #runner; #sessions;
  constructor(component, runner, stateRoot) {
    requireThat(runner?.contract === 'claude-private-runner-v1' &&
      ['execute', 'requestCleanup', 'assertOutputSafe', 'retire'].every(
        key => typeof runner[key] === 'function'),
    'CLAUDE_PREREQUISITE_UNAVAILABLE');
    this.#component = structuredClone(component);
    this.#runner = runner;
    this.#sessions = new RoleSessions(stateRoot);
  }
  async run(stage, context, inputs) {
    const plan = claudePlan(stage, { ...inputs, context }, this.#component);
    return this.#sessions.run(stage, context, async session => {
      const executionId = context.execution.id;
      let execution;
      try {
        execution = await this.#runner.execute({ plan, executionId,
          session: session.directory });
      } catch {
        // No raw executor exception (which may contain credentials) escapes.
        await this.#cleanup(executionId);
        throw new Error('CLAUDE_EXECUTOR_FAILURE_TERMINATION_UNPROVEN');
      }
      // A timeout or CLI exit is not proof of termination. Ask the runner to
      // clean up, then validate its separate termination evidence before use.
      await this.#cleanup(executionId);
      requireModelTermination(execution, executionId, plan.policyHash);
      requireThat(!execution.timedOut, 'CLAUDE_TIMEOUT');
      requireThat(typeof execution.stdout === 'string' &&
        typeof execution.stderr === 'string' &&
        Buffer.byteLength(execution.stdout) <= claudeLimits.stdout &&
        Buffer.byteLength(execution.stderr) <= claudeLimits.stderr &&
        !execution.outputLimitExceeded, 'CLAUDE_OUTPUT_LIMIT');
      try {
        requireThat(await this.#runner.assertOutputSafe(executionId,
          execution.stdout, execution.stderr) === true, 'CLAUDE_UNSAFE_OUTPUT');
      } catch { throw new Error('CLAUDE_UNSAFE_OUTPUT'); }
      if (execution.status === 'interrupted') {
        await this.#retire(executionId);
        return { status: 'interrupted', executionId,
          terminationHash: execution.terminationHash };
      }
      const parsed = parseClaudeResult(stage, execution.stdout);
      requireThat(execution.exitCode === 0, 'CLAUDE_PROCESS_ERROR');
      await this.#retire(executionId);
      // Workspace application and authoritative receipts belong to Core. This
      // component returns validated data only after trusted termination checks.
      return { ...parsed, executionId, terminationHash: execution.terminationHash,
        isolationHash: execution.isolationHash, probeHash: execution.probeHash };
    });
  }
  async #cleanup(executionId) {
    try { await this.#runner.requestCleanup(executionId); }
    catch { throw new Error('CLAUDE_CLEANUP_UNPROVEN'); }
  }
  async #retire(executionId) {
    try { await this.#runner.retire(executionId); }
    catch { throw new Error('CLAUDE_RETIREMENT_FAILED'); }
  }
}
