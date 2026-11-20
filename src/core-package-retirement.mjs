import { packageName, retirementEvidenceName, retirementReason }
  from './core-package-retirement-contract.mjs';
export { retirementReason, projectPackageCleanup }
  from './core-package-retirement-contract.mjs';

// Shared staged/rollback orchestration. Ports separate current facts and native
// effects from decisions; every destructive retry re-enters these same checks.
export async function retireCorePackages(ports, withGate = use => use()) {
  const report = [];
  const names = new Set();
  for (const entry of await ports.list()) {
    if (packageName.test(entry)) names.add(entry);
    else if (entry.startsWith('.retiring-') && entry.endsWith('.json')) {
      const name = entry.slice('.retiring-'.length, -'.json'.length);
      if (packageName.test(name) && retirementEvidenceName(name) === entry)
        names.add(name);
    }
  }
  for (const name of [...names].sort()) {
    try {
      const result = await withGate(async () => {
        const candidate = await ports.inspect(name);
        const recheck = async current => {
          const reason = await ports.protection(current);
          if (reason) throw Object.assign(new Error(reason), { code: reason });
          await ports.unused(current);
        };
        if (!candidate.absent) await recheck(candidate);
        await ports.remove(candidate, recheck);
        return { status: 'removed', code: 'PACKAGE_REMOVED' };
      });
      if (result.status === 'pending') {
        report.push({ status: 'retained', code: 'PACKAGE_GATE_PENDING' });
        break;
      }
      report.push({ package: name, ...result });
    } catch (error) {
      report.push({ package: name, status: 'retained', code: retirementReason(error) });
    }
  }
  return report;
}
