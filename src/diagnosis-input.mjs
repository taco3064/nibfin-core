import { requireThat } from './identity.mjs';
import { requestLocalDiagnosis } from './diagnosis-request.mjs';

export async function readDiagnosisInput(stream) {
  requireThat(!stream.isTTY, 'PRIVATE_DIAGNOSIS_INPUT_REQUIRED');
  const chunks = []; let size = 0;
  const timer = setTimeout(() => stream.destroy(
    Object.assign(new Error('Input deadline'), { code: 'INVALID_DIAGNOSIS_REQUEST' }),
  ), 5000);
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      requireThat(size <= 18432, 'INVALID_DIAGNOSIS_REQUEST');
      chunks.push(bytes);
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { requireThat(false, 'INVALID_DIAGNOSIS_REQUEST'); }
    clearTimeout(timer);
    return await requestLocalDiagnosis(value);
  } finally { clearTimeout(timer); }
}
