import contract from './core-rollout-result.json' with { type: 'json' };

export const packageName = new RegExp(contract.packageCleanup.packagePattern);
export const retirementEvidenceName = name => `.retiring-${name}.json`;

const reasons = new Set(contract.packageCleanup.codes);
export function retirementReason(error) {
  if (reasons.has(error?.code)) return error.code;
  if (['INSTALLATION_FILE_SET_CHANGED', 'INSTALLED_SOURCE_CHANGED',
    'SOURCE_COMPONENT_HASH_MISMATCH', 'SOURCE_MANIFEST_MISMATCH']
    .includes(error?.code)) return 'PACKAGE_CONTENTS_CHANGED';
  if (error instanceof SyntaxError || ['UNSAFE_INSTALLED_PATH',
    'UNSAFE_INSTALLED_FILE', 'INVALID_INSTALLATION_PIN'].includes(error?.code))
    return 'PACKAGE_CONTENTS_UNKNOWN';
  return 'PACKAGE_OBSERVATION_UNAVAILABLE';
}

// Projection is also applied by both typed result decoders. No arbitrary path,
// exception text, command, service configuration or credentials leave this port.
export function projectPackageCleanup(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => item &&
    (item.package === undefined || packageName.test(item.package)) &&
    contract.packageCleanup.statuses.includes(item.status) && reasons.has(item.code))
    .map(item => ({ ...(item.package ? { package: item.package } : {}),
      status: item.status, code: item.code }));
}
