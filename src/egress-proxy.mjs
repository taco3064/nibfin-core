import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';

// Playwright's pinned browser downloads use the CDN and its Microsoft redirect.
// Keep exact HTTPS destinations: a generic download failure never expands this list.
export const toolDownloadHosts = Object.freeze([
  'registry.npmjs.org', 'cdn.playwright.dev', 'playwright.download.prss.microsoft.com',
]);
export const allowedHosts = [
  'chatgpt.com', 'auth.openai.com', ...toolDownloadHosts,
];
// Shared by declarations and the standalone installed gateway.
export function exactProjectHost(value) {
  if (typeof value !== 'string' || value.trim() !== value ||
      value.length > 253 || /[^a-z0-9.-]/i.test(value) || net.isIP(value))
    return false;
  const parts = value.split('.');
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
  return parts.length >= 2 && parts.every(part => label.test(part)) &&
    /^[a-z]{2,63}$/i.test(parts.at(-1)) &&
    !['localhost', 'local', 'internal', 'lan', 'home', 'arpa', 'localdomain']
      .includes(parts.at(-1).toLowerCase());
}
export function projectDomains(hosts = []) {
  if (!Array.isArray(hosts) || !hosts.every(exactProjectHost))
    throw Error('INVALID_PROJECT_DOMAINS');
  return Object.freeze([...new Set(hosts.map(host => host.toLowerCase()))]);
}
export function validProjectEgress(policy, now = Date.now()) {
  return validEgress(policy, now) &&
    policy.hosts.every(host => exactProjectHost(host) && host === host.toLowerCase());
}
function validEgress(policy, now) {
  return policy?.schemaVersion === 1 &&
    Object.keys(policy).sort().join(',') ===
      'executionId,expiresAt,hosts,schemaVersion' &&
    /^[a-f0-9-]{36}$/.test(policy.executionId) &&
    Number.isSafeInteger(policy.expiresAt) && policy.expiresAt > now &&
    policy.expiresAt <= now + 32 * 60 * 1000 &&
    Array.isArray(policy.hosts) &&
    new Set(policy.hosts).size === policy.hosts.length &&
    policy.hosts.every(host => typeof host === 'string' &&
      /^[a-z0-9][a-z0-9.-]{0,252}$/.test(host) && !host.includes('..'));
}
export function validMcpEgress(policy, now = Date.now()) {
  return validEgress(policy, now) && policy.hosts.length <= 100;
}
export async function policyPermits(directory, host, project = false) {
  if (!directory) return false;
  let file;
  try {
    file = await open(directory + (project ? '/project.json' : '/current.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536 ||
        (stat.mode & 0o777) !== 0o444) return false;
    const policy = JSON.parse(await file.readFile('utf8'));
    const valid = project ? validProjectEgress : validMcpEgress;
    return valid(policy) && policy.hosts.includes(host);
  } catch { return false; }
  finally { await file?.close(); }
}
export function publicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a,b,c] = ip.split('.').map(Number);
  return !([0,10,127].includes(a) || a >= 224 || a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 ||
    a === 100 && b >= 64 && b <= 127 ||
    a === 198 && ([18,19].includes(b) || b === 51 && c === 100) ||
    a === 192 && (b === 0 || b === 88 && c === 99) ||
    a === 203 && b === 0 && c === 113);
}
// Fail closed on malformed/fragmented ClientHello. CONNECT alone is insufficient:
// CDN addresses can route a different SNI to an attacker-controlled hostname.
export function clientHelloHost(bytes) {
  if (bytes.length < 5) return null;
  if (bytes[0] !== 22 || bytes.readUInt16BE(3) > 16384) throw Error('Invalid TLS record');
  const end = 5 + bytes.readUInt16BE(3);
  if (bytes.length < end) return null;
  if (bytes[5] !== 1 || bytes.readUIntBE(6,3) !== end - 9)
    throw Error('Invalid ClientHello');
  let p = 43;
  p += 1 + bytes[p];
  p += 2 + bytes.readUInt16BE(p);
  p += 1 + bytes[p];
  const extensionEnd = p + 2 + bytes.readUInt16BE(p); p += 2;
  if (extensionEnd !== end) throw Error('Invalid extensions');
  let host;
  while (p < end) {
    const type = bytes.readUInt16BE(p), length = bytes.readUInt16BE(p+2); p += 4;
    if (p + length > end) throw Error('Invalid extension');
    if (type === 0) {
      if (host || length < 5 || bytes[p+2] !== 0 ||
          bytes.readUInt16BE(p) !== length-2 ||
          bytes.readUInt16BE(p+3) !== length-5) throw Error('Invalid SNI');
      host = bytes.subarray(p+5,p+length).toString('ascii');
    }
    p += length;
  }
  if (!host) throw Error('SNI required');
  return host;
}
export function createProxy({ mcpPolicyDirectory, resolveHost = lookup,
  connect = options => net.connect(options) } = {}) {
  const server = http.createServer((req,res) => { res.writeHead(403); res.end(); });
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {});
    const host = req.url?.split(':')[0]?.toLowerCase();
    if (req.url?.toLowerCase() !== host + ':443' || !(allowedHosts.includes(host) ||
        await policyPermits(mcpPolicyDirectory, host) ||
        await policyPermits(mcpPolicyDirectory, host, true))) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
    }
    let buffer = head, connecting = false;
    client.setTimeout(15000, () => client.destroy());
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const hello = async chunk => {
      if (connecting) return;
      buffer = Buffer.concat([buffer,chunk]);
      try {
        if (buffer.length > 65536) throw Error('Oversized hello');
        const sni = clientHelloHost(buffer);
        if (sni === null) return;
        if (sni.toLowerCase() !== host) throw Error('SNI mismatch');
        connecting = true; client.pause(); client.removeListener('data',hello);
        const addresses = await resolveHost(host,{family:4,all:true});
        if (!addresses.length || addresses.some(a => !publicIPv4(a.address)))
          throw Error('Non-public upstream');
        const upstream = connect({host:addresses[0].address,port:443});
        upstream.on('error', () => client.destroy());
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
        upstream.once('connect', () => {
          upstream.write(buffer); client.setTimeout(0);
          client.pipe(upstream); upstream.pipe(client); client.resume();
        });
      } catch { client.destroy(); }
    };
    client.on('data',hello);
    if (head.length) { buffer = Buffer.alloc(0); void hello(head); }
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  createProxy({ mcpPolicyDirectory: process.env.NIBFIN_MCP_POLICY_DIRECTORY })
    .listen(3128,'0.0.0.0');
