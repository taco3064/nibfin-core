// Unlike pre-effect CI waits, these states stay Pending without retry settlement.
export function pendingMcpObservation(code) {
  return [
    'USER_MCP_DISCOVERY_UNRESOLVED',
    'USER_MCP_DISCOVERY_SESSION_UNRESOLVED',
    'USER_MCP_CONFIG_TERMINATION_UNKNOWN',
    'USER_MCP_CONFIG_TIMEOUT',
    'USER_MCP_CONFIG_TOO_LARGE',
  ].includes(code);
}
