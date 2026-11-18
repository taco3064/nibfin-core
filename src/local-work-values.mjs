import { isId, requireThat } from './identity.mjs';

export const limits = Object.freeze({
  milliseconds: 20000, requests: 160, responseBytes: 2 * 1024 * 1024,
  fileBytes: 1024 * 1024, entries: 256, pages: 3, items: 100,
  outputBytes: 1024 * 1024, freshMilliseconds: 30000,
});
export function observation(value, source, observedAt, sourceTime, code = 'OBSERVED') {
  const time = Date.parse(sourceTime);
  const age = Date.parse(observedAt) - time;
  return { value, source, observedAt, sourceTime: Number.isFinite(time)
    ? new Date(time).toISOString() : null,
  freshness: !Number.isFinite(time) ? 'unknown'
    : age >= 0 && age <= limits.freshMilliseconds ? 'fresh' : 'stale', code };
}
export const unknown = (source, at, code) => observation(null, source, at, null, code);
export function reason(error) {
  if (error?.status === 401) return 'AUTHENTICATION_DENIED';
  if (error?.status === 403 || error?.status === 429) return 'ACCESS_OR_RATE_LIMIT';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'ACCESS_DENIED';
  if (error?.code === 'ENOENT') return 'UNAVAILABLE';
  const allowed = ['OBSERVATION_LIMIT', 'OBSERVATION_CHANGED', 'UNTRUSTED_EVIDENCE',
    'UNSUPPORTED_HOST', 'UNVERIFIED_BINDING', 'SUBJECT_MISMATCH'];
  return allowed.includes(error?.code) ? error.code : 'OBSERVATION_UNAVAILABLE';
}
export function safeName(value) {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    !/[\x00-\x1f\x7f/\\]/.test(value), 'UNVERIFIED_BINDING');
  return value;
}
export function subjectIdentity(user) {
  requireThat(isId(user?.id) && user.type === 'User' &&
    /^[A-Za-z0-9-]{1,39}$/.test(user.login), 'SUBJECT_MISMATCH');
  return { id: user.id, login: user.login };
}
