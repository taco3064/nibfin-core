import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { managedResources as resources } from '../src/managed-resource-contract.mjs';

const ids = { agent: 'a', hooks: 'b', [resources.claude.kind]: 'f' };
export const image = kind => `sha256:${ids[kind].repeat(64)}`;
export const namespace = { uidStart: 65536, gidStart: 131072, size: 65536 };
// The pinned CLI's `--version` line, as agentVersions reports it.
export const claudeVersion = '2.1.326 (Claude Code)';
// Claude-specific input bytes; only a Claude request reads them.
export const claudeInputs = Object.freeze({
  [resources.claude.recipe]: 'claude recipe', [resources.claude.package]: 'script',
  [resources.claude.shell]: 'shell', [resources.claude.profileFile]: 'claude policy',
});

// A local preparation IO double: an in-memory journal, images and one probe
// container whose kernel label is the AppArmor profile it was created under.
export function fixture(fault) {
  let container;
  const commands = [];
  const io = {
    state: null, gateOwner: null, images: {}, commands, proofs: 0,
    profile: undefined,
    inputs: async (architecture, { claude = false } = {}) => ({
      policy: 'fixed policy', recipe: 'fixed recipe',
      ...(claude ? { ...claudeInputs, versions: { claude: claudeVersion } } : {}),
    }),
    verifyEngine: async () => ({ identity: 'engine', namespace, accounts: {} }),
    load: async () => structuredClone(io.state),
    async save(state, previous) {
      assert.deepEqual(io.state, previous);
      io.state = structuredClone(state);
    },
    pristine: async () => { assert.equal(io.profile, undefined); },
    claudePristine: async () => {},
    gate: async owner => { io.gateOwner = owner; },
    clearGate: async owner => {
      assert.equal(io.gateOwner, owner);
      io.gateOwner = null;
    },
    controller: async () => {},
    availability: async () => {
      if (fault === 'native-unavailable')
        throw { code: 'RESOURCE_NATIVE_EXECUTABLE_UNAVAILABLE' };
    },
    async image(kind) {
      if (!io.images[kind]) io.images[kind] = image(kind);
      return io.images[kind];
    },
    policy: async () => {}, egress: async () => 'd'.repeat(64),
    confirmSource: async () => {},
    // Like the host: an existing profile is kept unless it equals the new one
    // or is exactly the `replaceable` profile, which is replaced.
    async publish(value, replaceable) {
      if (fault === 'profile-conflict') throw { code: 'ENGINE_FILE_CONFLICT' };
      const same = other => isDeepStrictEqual(io.profile, other);
      if (io.profile && !same(value) && !(replaceable && same(replaceable)))
        throw { code: 'ENGINE_FILE_CONFLICT' };
      io.profile = structuredClone(value);
    },
    processIdentity: async () => fault === 'process-unknown' ? null : '42',
    async verifyStopped() {
      if (fault === 'termination-unknown')
        throw { code: 'RESOURCE_PROBE_TERMINATION_UNKNOWN' };
    },
    async kernelProof() {
      io.proofs++;
      return {
        label: `${container.apparmor} (enforce)`,
        uidMap: `0 ${namespace.uidStart} 65536`,
        gidMap: `0 ${fault === 'second-slot' && io.proofs === 3
          ? 42 : namespace.gidStart} 65536`,
      };
    },
    async docker(managed, args) {
      assert.equal(managed, true);
      commands.push(args);
      if (args[0] === 'create') {
        if (fault === 'create-unknown') throw { code: 'RESOURCE_PROBE_CREATE_UNKNOWN' };
        assert(args.includes('--network=none'));
        assert(args.includes('--user=1000:1000'));
        container = {
          Id: 'c'.repeat(64), Name: `/${args[args.indexOf('--name') + 1]}`,
          Image: args.at(-2),
          Config: { Labels: { 'io.nibfin.resource-preparation': io.state.owner } },
          State: { Running: false, Pid: 123 },
          apparmor: args.find(arg => arg.startsWith('--security-opt=apparmor='))
            .slice('--security-opt=apparmor='.length),
        };
        return container.Id;
      }
      if (args[0] === 'start') { container.State.Running = true; return ''; }
      if (args[0] === 'inspect') return JSON.stringify([container]);
      if (args[0] === 'rm') {
        if (fault !== 'cleanup-unknown') container = null;
        return '';
      }
      if (args[0] === 'ps') return container?.Id ?? '';
      throw new Error(`Unexpected command ${args[0]}`);
    },
  };
  return io;
}
