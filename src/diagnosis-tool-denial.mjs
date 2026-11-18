// Fixed external tool environment for diagnosis. No request method, including
// tool execution, can spawn a process, read a file, run a build or dispatch CI.
// Failure to initialize this environment is safe; local fallback is disabled.
export const diagnosisToolDenial = `
let size = 0, pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  size += Buffer.byteLength(chunk);
  if (size > 65536) process.exit(1);
  pending += chunk;
  const lines = pending.split('\\n');
  pending = lines.pop();
  for (const line of lines) {
    let request;
    try { request = JSON.parse(line); } catch { process.exit(1); }
    if (request.id === undefined) continue;
    const reply = { jsonrpc: '2.0', id: request.id };
    if (request.method === 'initialize') reply.result = { sessionId: 'diagnosis' };
    else reply.error = { code: -32601, message: 'DIAGNOSIS_TOOLS_DENIED' };
    process.stdout.write(JSON.stringify(reply) + '\\n');
  }
});
setTimeout(() => process.exit(1), 120000).unref();
`;
