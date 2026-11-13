import { requireThat } from './identity.mjs';

// Canonical SemVer 2.0.0, without a tag's optional v prefix.
export function releaseVersion(value) {
  const core = '(0|[1-9][0-9]*)';
  const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
  const pattern = new RegExp(
    `^${core}\\.${core}\\.${core}` +
      `(?:-${identifier}(?:\\.${identifier})*)?` +
      '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
  );
  requireThat(
    typeof value === 'string' && value.length <= 256 && pattern.test(value),
    'INVALID_RELEASE_VERSION',
  );
  return value;
}
