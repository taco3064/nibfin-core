import { mock } from 'node:test';

const [directory] = process.argv.slice(2);
mock.module('../src/core-management-gate.mjs', { namedExports: {
  managementDirectory: directory,
  withCoreManagementGate: async () => {
    throw new Error('Must reuse inherited description without another flock');
  },
} });
mock.module('../src/host-paths.mjs', { namedExports: {
  rootOwnedPath: async path => {
    if (![directory, '/opt/nibfin'].includes(path)) throw new Error('Unexpected path');
  },
} });
mock.module('../src/core-package-retirement.mjs', { namedExports: {
  retireCorePackages: async () => [{ status: 'removed', code: 'PACKAGE_REMOVED' }],
  retirementReason: () => 'PACKAGE_OBSERVATION_UNAVAILABLE',
} });
const { retireInstalledCorePackages } =
  await import('../src/core-package-retirement-host.mjs');
process.stdout.write(JSON.stringify(await retireInstalledCorePackages()));
