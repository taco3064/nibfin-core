import { createHash } from 'node:crypto';

// Selectively adapted from the reference's JSON-only evidence identities.
// Reject values that JSON would silently omit, coerce or interpret as methods.
export function canonical(value, parents = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || parents.has(value)) throw new Error('Invalid evidence value');
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Plain JSON evidence required');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !(array && key === 'length') && !Object.getOwnPropertyDescriptor(value, key)?.enumerable)) {
    throw new Error('Hidden evidence property');
  }
  if (array && (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key)))) {
    throw new Error('Sparse or extended evidence array');
  }
  for (const key of keys) {
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) throw new Error('Evidence accessor rejected');
  }
  parents.add(value);
  try {
    if (array) return `[${value.map(item => canonical(item, parents)).join(',')}]`;
    return `{${keys.sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], parents)}`).join(',')}}`;
  } finally { parents.delete(value); }
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const gitBlob = bytes => createHash('sha1').update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest('hex');
export const isSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const isId = value => Number.isSafeInteger(value) && value > 0;
export function requireThat(value, code) {
  if (!value) throw Object.assign(new Error(code), { code });
}
