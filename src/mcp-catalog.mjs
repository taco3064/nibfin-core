import { requireThat } from './identity.mjs';
import { disabledMcpServer } from './mcp-profile.mjs';
import { mcpHttpRequest } from './mcp-http.mjs';

async function boundedBody(response) {
  let size = 0;
  const parts = [];
  if (!response.body) return '';
  for await (const bytes of response.body) {
    size += bytes.length;
    requireThat(size <= 2 * 1024 * 1024, 'USER_MCP_CATALOG_TOO_LARGE');
    parts.push(bytes);
  }
  return Buffer.concat(parts).toString('utf8');
}

function responseMessage(text, id) {
  let messages;
  if (text.trimStart().startsWith('{')) messages = [JSON.parse(text)];
  else {
    messages = text.split(/\r?\n\r?\n/).flatMap(event => {
      const data = event.split(/\r?\n/).filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).trimStart()).join('\n');
      return data ? [JSON.parse(data)] : [];
    });
  }
  const matches = messages.filter(message => message.id === id);
  requireThat(matches.length === 1 && !matches[0].error,
    'INVALID_USER_MCP_CATALOG_RESPONSE');
  return matches[0].result;
}

// Discovery only: this component never implements or calls an MCP tool.
// The inherited URL/header configuration is host-supplied, never Issue input.
export async function discoverReadOnlyMcpTools(
  server, fetcher = mcpHttpRequest, lifecycle = {},
) {
  let session, observed = false, protocol = '2025-06-18', sequence = 0;
  const request = async (method, params, notification = false) => {
    const id = ++sequence;
    const response = await fetcher(server.url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: {
        ...server.http_headers, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(session ? { 'Mcp-Session-Id': session } : {}),
        ...(method !== 'initialize' ? { 'MCP-Protocol-Version': protocol } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }),
        method, params }),
    });
    if (method === 'initialize') {
      session = response.headers.get('mcp-session-id');
      requireThat(!session || /^[\x21-\x7e]{1,1024}$/.test(session),
        'INVALID_USER_MCP_SESSION');
      await lifecycle.observed?.(session);
      observed = true;
    }
    requireThat(response.status !== 401, 'USER_MCP_EXISTING_LOGIN_UNAVAILABLE');
    requireThat(response.status !== 403, 'USER_MCP_ACCESS_DENIED');
    requireThat(response.ok, 'USER_MCP_CATALOG_UNAVAILABLE');
    const text = await boundedBody(response);
    return notification ? null : responseMessage(text, id);
  };
  try {
    const initialized = await request('initialize', {
      protocolVersion: protocol, capabilities: {},
      clientInfo: { name: 'nibfin-mcp-inheritance', version: '1' },
    });
    requireThat(['2025-03-26', '2025-06-18', '2025-11-25']
      .includes(initialized?.protocolVersion), 'USER_MCP_PROTOCOL_UNSUPPORTED');
    protocol = initialized.protocolVersion;
    await request('notifications/initialized', {}, true);
    const tools = [], seen = new Set();
    let cursor;
    for (let page = 0; page < 100; page++) {
      const result = await request('tools/list', cursor ? { cursor } : {});
      requireThat(Array.isArray(result?.tools), 'INVALID_USER_MCP_CATALOG');
      for (const tool of result.tools) {
        requireThat(typeof tool.name === 'string' && tool.name &&
          !seen.has(tool.name) && seen.size < 1000, 'INVALID_USER_MCP_CATALOG');
        seen.add(tool.name);
        if (tool.annotations?.readOnlyHint === true &&
            tool.annotations.destructiveHint !== true) tools.push(tool.name);
      }
      if (!result.nextCursor) return tools;
      requireThat(typeof result.nextCursor === 'string' &&
        result.nextCursor !== cursor, 'INVALID_USER_MCP_CATALOG_CURSOR');
      cursor = result.nextCursor;
    }
    throw Object.assign(new Error('USER_MCP_CATALOG_TRUNCATED'), {
      code: 'USER_MCP_CATALOG_TRUNCATED',
    });
  } catch (error) {
    // DNS/public-address refusal precedes any HTTP/session creation.
    if (['USER_MCP_NONPUBLIC_ENDPOINT', 'USER_MCP_ENDPOINT_RESOLUTION_FAILED']
      .includes(error.code)) observed = true;
    throw error;
  } finally {
    if (session) {
      // Session retirement is not a tool action or a retry of a data mutation.
      const response = await fetcher(server.url, {
        method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { ...server.http_headers, 'Mcp-Session-Id': session,
          'MCP-Protocol-Version': protocol },
      });
      requireThat(response.ok || response.status === 404 || response.status === 405,
        'USER_MCP_DISCOVERY_SESSION_UNRESOLVED');
      await response.body?.cancel();
    }
    if (observed) await lifecycle.retired?.();
  }
}

export async function restrictMcpToReadOnly(
  profile, discover = discoverReadOnlyMcpTools,
) {
  for (const [name, server] of Object.entries(profile.configuration.mcp_servers)) {
    if (server.enabled === false) continue;
    try {
      const readOnly = await discover(server);
      const permitted = readOnly.filter(tool =>
        (server.enabled_tools === undefined || server.enabled_tools.includes(tool)) &&
          !server.disabled_tools?.includes(tool));
      requireThat(permitted.length > 0, 'USER_MCP_NO_READ_ONLY_TOOLS');
      server.enabled_tools = permitted;
    } catch (error) {
      if (['USER_MCP_DISCOVERY_UNRESOLVED',
        'USER_MCP_DISCOVERY_SESSION_UNRESOLVED'].includes(error.code)) throw error;
      profile.metadata.diagnostics.push({ name,
        code: error.code ?? 'USER_MCP_CATALOG_UNAVAILABLE' });
      requireThat(server.required !== true, 'REQUIRED_USER_MCP_UNAVAILABLE');
      profile.configuration.mcp_servers[name] = disabledMcpServer();
    }
  }
  return profile;
}
