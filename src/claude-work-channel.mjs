import { requireThat } from './identity.mjs';
import { roleCapabilities } from './provider-contract.mjs';

export const claudeWorkChannel = 'claude-scoped-work-v1';
export const claudeWorkSocket = '/session/work-channel/worker.sock';
const command = '/opt/nibfin/claude/bin/work-tools';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function claudeWorkServer() {
  return { type: 'stdio', command, args: [], env: {} };
}

function operations(stage) {
  return roleCapabilities(stage).workspace === 'write'
    ? ['read', 'check', 'write'] : ['read', 'check'];
}

export function claudeTools(stage) {
  return operations(stage).map(operation => `mcp__work__${operation}`);
}

// The launcher owns the intended execution. The worker authenticates its peer
// from the private transport. Neither identity nor role comes from MCP input.
export function bindClaudeWorkChannel(stage, executionId) {
  requireThat(typeof executionId === 'string' && uuid.test(executionId),
    'INVALID_CLAUDE_WORK_EXECUTION');
  const allowed = operations(stage);
  return (peerExecutionId, operation) => {
    requireThat(peerExecutionId === executionId, 'CLAUDE_WORK_EXECUTION_MISMATCH');
    requireThat(allowed.includes(operation), 'CLAUDE_WORK_OPERATION_DENIED');
  };
}
