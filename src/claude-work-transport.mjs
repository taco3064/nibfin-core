export const claudeWorkChannel = 'claude-scoped-work-v1';
export const claudeWorkSocket = '/session/work-channel/worker.sock';
const command = '/opt/nibfin/claude/bin/work-tools';

export function claudeWorkServer() {
  return { type: 'stdio', command, args: [], env: {} };
}

