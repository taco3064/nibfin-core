export const coreMaintenanceContract = Object.freeze({
  schemaVersion: 1, mode: 'core-only', eventName: 'workflow_dispatch',
  producer: 'taco3064/nibfin-core',
  workflowPath: '.github/workflows/core-maintenance.yml', jobName: 'core-maintenance',
  audience: 'nibfin:core-maintenance',
});
