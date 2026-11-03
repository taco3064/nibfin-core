import { digest } from '../src/identity.mjs';
export const now = Date.parse('2026-11-03T12:00:00Z');
export function approvalRecord() {
  return {
    schemaVersion: 1,
    issue: { id: 'I_target', repository: 'example/core', repositoryId: 10, number: 2 },
    scope: { body: 'Implement the approved work.\n', hash: digest('Implement the approved work.\n') },
    prerequisites: [], operations: ['shape', 'validate-shape', 'publish-shape', 'deliver', 'accept'],
    roles: { author: 1, validator: 2, publisher: 3, writer: 1, acceptor: 2 },
    source: { repository: 'example/engine', commit: 'a'.repeat(40), policyHash: 'b'.repeat(64), skillsHash: 'c'.repeat(64) },
    validFrom: '2026-11-03T00:00:00Z', expiresAt: '2026-11-04T00:00:00Z',
  };
}
