import { requireThat } from './identity.mjs';
import { observeLocalWork } from './local-work-observation.mjs';

export async function readLocalWorkInput(stream) {
  requireThat(!stream.isTTY, 'PRIVATE_OBSERVATION_INPUT_REQUIRED');
  const chunks = []; let size = 0;
  const timer = setTimeout(() => stream.destroy(
    Object.assign(new Error('Input deadline'), { code: 'INVALID_OBSERVATION_INPUT' }),
  ), 5000);
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      requireThat(size <= 17408, 'INVALID_OBSERVATION_INPUT');
      chunks.push(bytes);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { requireThat(false, 'INVALID_OBSERVATION_INPUT'); }
    requireThat(value && Object.keys(value).join(',') === 'token',
      'INVALID_OBSERVATION_INPUT');
    clearTimeout(timer);
    return await observeLocalWork(value.token);
  } finally { clearTimeout(timer); }
}
