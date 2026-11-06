import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { Readable } from 'node:stream';
import { publicIPv4 } from './egress-proxy.mjs';
import { requireThat } from './identity.mjs';

// Host-side discovery must obey the same public-address boundary as the gateway.
// Pin the resolved address for this request; never follow redirects or re-resolve
// between validation and connection. TLS still verifies the original hostname.
export async function mcpHttpRequest(endpoint, options, {
  resolve = lookup, request = https.request,
} = {}) {
  const url = new URL(endpoint);
  requireThat(url.protocol === 'https:' && !url.username && !url.password &&
    (!url.port || url.port === '443'), 'UNSUPPORTED_USER_MCP_ENDPOINT');
  let timer, addresses;
  try {
    addresses = await Promise.race([
      resolve(url.hostname, { family: 4, all: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('DNS timeout')), 15000);
      }),
    ]);
  } catch {
    requireThat(false, 'USER_MCP_ENDPOINT_RESOLUTION_FAILED');
  } finally { clearTimeout(timer); }
  requireThat(addresses.length > 0 && addresses.every(a => publicIPv4(a.address)),
    'USER_MCP_NONPUBLIC_ENDPOINT');
  return new Promise((resolveResponse, reject) => {
    const headers = { ...options.headers, Host: url.host };
    const req = request({
      hostname: addresses[0].address, port: 443, servername: url.hostname,
      path: url.pathname + url.search, method: options.method, headers,
      signal: options.signal, agent: false,
    }, response => {
      try {
        const status = response.statusCode;
        const empty = [204, 205, 304].includes(status);
        if (empty) response.resume();
        // Return headers immediately so the session ID is durably recorded even
        // when the bounded response stream later fails or times out.
        resolveResponse(new Response(empty ? null : Readable.toWeb(response), {
          status, headers: response.headers,
        }));
      } catch (error) { response.destroy(); reject(error); }
    });
    req.on('error', reject);
    req.end(options.body);
  });
}
