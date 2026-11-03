import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';

// Playwright's pinned browser downloads use the CDN and its Microsoft redirect.
// Keep exact HTTPS destinations: a generic download failure never expands this list.
export const allowedHosts = ['chatgpt.com', 'auth.openai.com', 'registry.npmjs.org', 'cdn.playwright.dev', 'playwright.download.prss.microsoft.com'];
export function publicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a,b,c] = ip.split('.').map(Number);
  return !([0,10,127].includes(a) || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && ([18,19].includes(b) || b === 51 && c === 100) || a === 192 && (b === 0 || b === 88 && c === 99) || a === 203 && b === 0 && c === 113);
}
// Fail closed on malformed/fragmented ClientHello. CONNECT alone is insufficient:
// CDN addresses can route a different SNI to an attacker-controlled hostname.
export function clientHelloHost(bytes) {
  if (bytes.length < 5) return null;
  if (bytes[0] !== 22 || bytes.readUInt16BE(3) > 16384) throw Error('Invalid TLS record');
  const end = 5 + bytes.readUInt16BE(3);
  if (bytes.length < end) return null;
  if (bytes[5] !== 1 || bytes.readUIntBE(6,3) !== end - 9) throw Error('Invalid ClientHello');
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
      if (host || length < 5 || bytes[p+2] !== 0 || bytes.readUInt16BE(p) !== length-2 || bytes.readUInt16BE(p+3) !== length-5) throw Error('Invalid SNI');
      host = bytes.subarray(p+5,p+length).toString('ascii');
    }
    p += length;
  }
  if (!host) throw Error('SNI required');
  return host;
}
export function createProxy() {
  const server = http.createServer((req,res) => { res.writeHead(403); res.end(); });
  server.on('connect', (req, client, head) => {
    client.on('error', () => {});
    const host = req.url?.split(':')[0];
    if (!allowedHosts.includes(host) || req.url !== host + ':443') { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
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
        if (sni !== host) throw Error('SNI mismatch');
        connecting = true; client.pause(); client.removeListener('data',hello);
        const addresses = await lookup(host,{family:4,all:true});
        if (!addresses.length || addresses.some(a => !publicIPv4(a.address))) throw Error('Non-public upstream');
        const upstream = net.connect({host:addresses[0].address,port:443});
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) createProxy().listen(3128,'0.0.0.0');
