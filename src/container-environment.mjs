import { digest } from './identity.mjs';

function environmentRecord(entries) {
  if (!Array.isArray(entries)) return null;
  const result = Object.create(null);
  for (const entry of entries) {
    if (typeof entry !== 'string') return null;
    const separator = entry.indexOf('=');
    if (separator < 1) return null;
    const name = entry.slice(0, separator);
    if (Object.hasOwn(result, name)) return null;
    result[name] = entry.slice(separator + 1);
  }
  return { ...result };
}

// Docker may reorder Env. Compare exact unique names/values, not array order.
export function sameContainerEnvironment(actual, expected) {
  const left = environmentRecord(actual), right = environmentRecord(expected);
  return left !== null && right !== null && digest(left) === digest(right);
}
