import test from 'node:test';
import assert from 'node:assert/strict';
import { withUserMcp } from '../src/mcp-agent.mjs';
import { jobMcpProfile } from '../src/mcp-job.mjs';
import { pressureFixture } from './host-pressure-fixture.mjs';
import { hostMemoryPressure } from '../src/host-memory-pressure.mjs';

// Use the maintained Job consumer ledger, without credentials or a live MCP.
test('confirmed terminated pressure can settle the existing MCP consumer ledger',
  async () => {
    for (const fault of [undefined, 'binding', 'termination', 'pending']) {
      const memoryPressure = pressureFixture();
      const profile = { expiresAt: null, configuration: { mcp_servers: {} },
        metadata: {}, policyHash: 'a'.repeat(64), secrets: [] };
      const job = jobMcpProfile(async () => profile);
      const wrapper = withUserMcp({ execute: async () => ({
        status: fault === 'pending' ? 'pending' : 'interrupted',
        code: hostMemoryPressure, memoryPressure,
        ...(fault === 'termination' ? {} : { terminationHash: 'b'.repeat(64) }),
      }) }, {}, () => job.read(), job);
      await wrapper.execute({ plan: { args: [], prompt: '' },
        pressureBinding: { ...memoryPressure.binding,
          ...(fault === 'binding' ? { runnerId: 99 } : {}) } });
      if (fault) await assert.rejects(job.retire([], true),
        { code: 'MCP_JOB_TERMINATION_UNPROVEN' });
      else await job.retire([], true);
    }
  });
