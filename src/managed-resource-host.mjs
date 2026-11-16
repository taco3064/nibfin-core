import { readFile, readdir, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, requireThat } from './identity.mjs';
import { boundedHostFile, coreRoot } from './host-adoption.mjs';
import { rootOwnedPath } from './host-paths.mjs';
import { engineHost } from './engine-host.mjs';
import { verifyManagedEngine } from './engine-verify.mjs';
import {
  optionalStat, ownedDirectory, exactFile, installEngineFile,
  readEngineState, saveEngineState, requireDirectoryEntries,
} from './engine-files.mjs';
import { managedResources as resources } from './managed-resource-contract.mjs';
import { prepareSharedAccounts } from './shared-host-setup.mjs';
import { managedPaths } from './managed-credential-files.mjs';
import { resourcePreparationGate } from './managed-resource-admission.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';

const security = join(coreRoot, 'src/security');
const journal = `${resources.state}/state.json`;
const tag = kind => `nibfin-managed-resource:${kind}`;

async function kernelPolicy() {
  const base = '/sys/kernel/security/apparmor/policy/profiles';
  const matches = [];
  for (const directory of await readdir(base)) {
    const path = join(base, directory);
    if ((await readFile(join(path, 'name'), 'utf8')).trim() === resources.apparmor) {
      const hash = (await readFile(join(path, 'sha1'), 'utf8')).trim();
      requireThat(/^[a-f0-9]{40,64}$/.test(hash) &&
        (await readFile(join(path, 'mode'), 'utf8')).trim() === 'enforce',
      'RESOURCE_POLICY_IDENTITY_UNPROVEN');
      matches.push(hash);
    }
  }
  requireThat(matches.length <= 1, 'RESOURCE_POLICY_IDENTITY_UNPROVEN');
  return matches[0] ?? null;
}

// The fixed installed composition supplies no overrides; tests use a local IO double.
export function managedResourceHost(confirmSource, engine = engineHost()) {
  const docker = args => engine.docker(true, args);
  const io = {
    ...engine,
    confirmSource,
    verifyEngine: () => verifyManagedEngine(engine),
    async initialize() {
      await ownedDirectory(resources.state);
      await requireDirectoryEntries(resources.state,
        ['state.json', 'policy.json', 'recovery.lock']);
    },
    load: () => readEngineState(journal),
    save: (state, previous) => saveEngineState(journal, state, previous),
    async processIdentity(pid) {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async verifyStopped(pid, identity) {
      for (let attempt = 0; attempt < 20; attempt++) {
        if (await io.processIdentity(pid) !== identity) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      requireThat(false, 'RESOURCE_PROBE_TERMINATION_UNKNOWN');
    },
    async inputs() {
      const inputs = {};
      for (const name of Object.values(resources.recipes))
        inputs[name] = await boundedHostFile(join(security, name), 16384);
      for (const name of ['package.json', 'package-lock.json'])
        inputs[name] = await boundedHostFile(join(security, 'managed-npm', name),
          1024 * 1024);
      inputs.policy = await boundedHostFile(
        join(security, 'codex-security.apparmor'), 16384);
      return inputs;
    },
    async pristine() {
      for (const path of [resources.profile, resources.policy, resourcePreparationGate])
        requireThat(!await optionalStat(path), 'RESOURCE_FOREIGN_CONFIGURATION');
      requireThat(!await kernelPolicy(), 'RESOURCE_FOREIGN_POLICY');
      for (const kind of ['agent', 'hooks'])
        requireThat(!(await docker(['image', 'ls', '-q', tag(kind)])).trim(),
          'RESOURCE_FOREIGN_IMAGE');
      requireThat(!(await docker(['network', 'ls', '-q', '--filter',
        `name=^${resources.egress}$`])).trim(), 'RESOURCE_FOREIGN_NETWORK');
    },
    async gate(owner) {
      await installEngineFile(resourcePreparationGate, owner + '\n', 0o644);
    },
    async clearGate(owner) {
      await exactFile(resourcePreparationGate, owner + '\n', 0o644);
      await unlink(resourcePreparationGate);
      await syncRecoveryDirectory('/etc/nibfin');
    },
    async controller() {
      await prepareSharedAccounts(managedPaths, { preparation: true });
    },
    async image(kind, state, inputs, observe) {
      const marker = digest({ owner: state.owner, inputs: state.inputs, kind });
      let found = (await docker(['image', 'ls', '--no-trunc', '-q', tag(kind)])).trim();
      if (!found) {
        requireThat(!observe, 'RESOURCE_IMAGE_RECONCILIATION_REQUIRED');
        let recipe = inputs[resources.recipes[kind]];
        if (kind === 'hooks')
          recipe = recipe.replace('nibfin-managed-agent-input', state.images.agent);
        await engine.docker(true, ['build', '--no-cache', '--network=host',
          '--label', `${resources.label}=${marker}`, '--tag', tag(kind),
          '--file', '-', security], { input: recipe, timeout: 30 * 60 * 1000,
          limit: 4 * 1024 * 1024 }).catch(() => {});
        found = (await docker(['image', 'ls', '--no-trunc', '-q', tag(kind)])).trim();
      }
      requireThat(/^sha256:[a-f0-9]{64}$/.test(found),
        'RESOURCE_IMAGE_RECONCILIATION_REQUIRED');
      const rows = JSON.parse(await docker(['image', 'inspect', found]));
      const row = rows[0];
      requireThat(rows.length === 1 && row.Id === found &&
        row.Os === 'linux' && row.Architecture === 'amd64' &&
        row.Config?.Labels?.[resources.label] === marker &&
        row.RepoTags?.includes(tag(kind)), 'RESOURCE_IMAGE_CONFLICT');
      return found;
    },
    async policy(bytes, observe) {
      const proofPath = `${resources.state}/policy.json`;
      // Intent alone does not prove which policy the kernel loaded. A crash in
      // the load/record window requires reconciliation, never blind replacement.
      if (observe) {
        const proof = await readEngineState(proofPath);
        requireThat(proof && proof.input === digest(bytes) &&
          proof.kernel === await kernelPolicy(),
        'RESOURCE_POLICY_RECONCILIATION_REQUIRED');
        await exactFile(resources.policy, bytes, 0o644);
        return;
      }
      requireThat(!await kernelPolicy(), 'RESOURCE_FOREIGN_POLICY');
      await installEngineFile(resources.policy, bytes, 0o644);
      await engine.run('/usr/sbin/apparmor_parser', ['--add', resources.policy]);
      const kernel = await kernelPolicy();
      requireThat(kernel, 'RESOURCE_POLICY_RECONCILIATION_REQUIRED');
      await saveEngineState(proofPath, { input: digest(bytes), kernel }, null);
    },
    async egress(owner, observe) {
      const ids = () => docker(['network', 'ls', '-q', '--no-trunc', '--filter',
        `name=^${resources.egress}$`]);
      let id = (await ids()).trim();
      if (!id) {
        requireThat(!observe, 'RESOURCE_NETWORK_RECONCILIATION_REQUIRED');
        await docker(['network', 'create', '--driver=bridge',
          '--label', `${resources.label}=${owner}`, resources.egress]).catch(() => {});
        id = (await ids()).trim();
      }
      requireThat(/^[a-f0-9]{64}$/.test(id),
        'RESOURCE_NETWORK_RECONCILIATION_REQUIRED');
      const rows = JSON.parse(await docker(['network', 'inspect', id]));
      const row = rows[0];
      requireThat(rows.length === 1 && row.Id === id &&
        row.Name === resources.egress && row.Driver === 'bridge' &&
        row.Scope === 'local' && row.Internal === false && row.Ingress === false &&
        row.Labels?.[resources.label] === owner &&
        Object.keys(row.Options ?? {}).length === 0,
      'RESOURCE_NETWORK_CONFLICT');
      return id;
    },
    async publish(profile) {
      await rootOwnedPath('/etc/nibfin');
      await installEngineFile(resources.profile, JSON.stringify(profile, null, 2) + '\n',
        0o644);
      const stat = await lstat(resources.profile);
      requireThat(stat.uid === 0, 'RESOURCE_PROFILE_NOT_ROOT_OWNED');
    },
  };
  return io;
}
