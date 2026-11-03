import test from 'node:test';
import assert from 'node:assert/strict';
import { publicIPv4, clientHelloHost, allowedHosts, createProxy } from '../src/egress-proxy.mjs';
import { request } from 'node:http';

function hello(host) {
  const name = Buffer.from(host), sni = Buffer.alloc(9 + name.length);
  sni.writeUInt16BE(0, 0); sni.writeUInt16BE(name.length + 5, 2); sni.writeUInt16BE(name.length + 3, 4);
  sni[6] = 0; sni.writeUInt16BE(name.length, 7); name.copy(sni, 9);
  const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0, 0, 2, 0x13, 1, 1, 0]),
    Buffer.from([0, sni.length]), sni]);
  const header = Buffer.alloc(9); header[0] = 22; header.writeUInt16BE(0x0301, 1);
  header.writeUInt16BE(body.length + 4, 3); header[5] = 1; header.writeUIntBE(body.length, 6, 3);
  return Buffer.concat([header, body]);
}
test('egress refuses private, metadata, shared, reserved and documentation addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '192.0.2.1', '198.51.100.1', '203.0.113.1', '198.18.0.1', '224.0.0.1', '::1', '0.0.0.0']) assert.equal(publicIPv4(address), false, address);
  assert.equal(publicIPv4('1.1.1.1'), true);
});
test('TLS ClientHello binds the CONNECT destination to exact SNI and refuses malformed handshakes', () => {
  const packet = hello('chatgpt.com'); assert.equal(clientHelloHost(packet), 'chatgpt.com');
  assert.equal(clientHelloHost(packet.subarray(0, 8)), null);
  const invalid = Buffer.from(packet); invalid[0] = 23; assert.throws(() => clientHelloHost(invalid));
  const mismatch = Buffer.from(packet); mismatch.writeUIntBE(1, 6, 3); assert.throws(() => clientHelloHost(mismatch));
  assert.equal(allowedHosts.includes('github.com'), false); assert.equal(allowedHosts.some(host => host.includes('*')), false);
});
test('proxy rejects ordinary HTTP traffic locally without contacting any upstream', async t => {
  const server = createProxy(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path: 'http://attacker.invalid/' }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
});
