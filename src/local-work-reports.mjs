import { diagnosisHistory } from './diagnosis-history.mjs';
import { join } from 'node:path';
import { digest, requireThat } from './identity.mjs';
import { observationEntries, readObservationFile } from './local-work-files.mjs';
import { projectBlockerReport } from './blocker-report.mjs';
import { blockerReportsName } from './blocker-report-store.mjs';
import { limits } from './local-work-values.mjs';

// Historical selection is independent of active runs and open scoped Issues.
export function localReportReader(host, {
  read = readObservationFile, entries = observationEntries,
} = {}) {
  const snapshots = new Map(), directories = new Map();
  const deadline = Date.now() + limits.milliseconds;
  let reads = 0;
  const budget = () => requireThat(++reads <= limits.entries && Date.now() < deadline,
    'OBSERVATION_LIMIT');
  const readEntries = async path => {
    budget();
    const names = await entries(path, host.uid);
    directories.set(path, digest(names));
    return names;
  };
  const readJSON = async path => {
    budget();
    const file = await read(path, host.uid, 2 * 1024 * 1024);
    requireThat(!snapshots.has(path) || snapshots.get(path) === file.bytes,
      'OBSERVATION_CHANGED');
    snapshots.set(path, file.bytes);
    return JSON.parse(file.bytes);
  };
  return {
    diagnoses: issue => diagnosisHistory(host, issue, { readJSON, entries: readEntries }),
    async reports(issue) {
      const root = join(host.stateRoot,
        `issue-${issue.repositoryId}-${issue.number}`, 'receipts', blockerReportsName);
      const names = await readEntries(root);
      const reports = [];
      for (const name of names) {
        requireThat(/^[a-f0-9]{64}\.json$/.test(name), 'UNTRUSTED_REPORT');
        const path = join(root, name);
        const report = await readJSON(path);
        requireThat(report.id === name.slice(0, -5), 'UNTRUSTED_REPORT');
        const projected = projectBlockerReport(report,
          { issue, subjectId: host.subjectId });
        reports.push({ report, projected });
      }
      return reports;
    },
    async confirm() {
      for (const [path, hash] of directories)
        requireThat(digest(await entries(path, host.uid)) === hash,
          'OBSERVATION_CHANGED');
      for (const [path, bytes] of snapshots) {
        requireThat(Date.now() < deadline, 'OBSERVATION_LIMIT');
        requireThat((await read(path, host.uid, 2 * 1024 * 1024)).bytes === bytes,
          'OBSERVATION_CHANGED');
      }
    },
  };
}

export function selectReports(reports, attempt) {
  return reports.filter(({ report }) => {
    const binding = report.binding;
    return binding.stage === attempt.stage &&
      binding.admissionId === attempt.id;
  });
}

export function reportEvidenceIdentity(reports) {
  return digest(reports.map(({ report }) => report.id).sort());
}
