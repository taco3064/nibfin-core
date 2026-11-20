import { coreRoot } from './host-adoption.mjs';
import { requireThat } from './identity.mjs';
import { retireInstalledPackages } from './package-retirement.mjs';

requireThat(process.platform === 'linux' && process.getuid() === 0 &&
  coreRoot === '/opt/nibfin/core' && process.argv.length === 2,
'PACKAGE_RETIREMENT_REQUIRES_INSTALLED_ADMINISTRATOR');
console.log(JSON.stringify(await retireInstalledPackages()));
