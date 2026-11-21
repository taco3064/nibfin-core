import { readFile, readdir, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, requireThat } from './identity.mjs';
import { linuxArchitecture } from './linux-architecture.mjs';
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
import {
  prepareAgentInputs, managedAgentRecipe, resolvedClaudeRecipe, agentVersions,
} from './agent-image-inputs.mjs';
import { browserRuntimeProbe } from './browser-runtime-inputs.mjs';
import { versionProbe } from './tool-recipe.mjs';
import { syncRecoveryDirectory } from './recovery-lock.mjs';
import { installStorageReclamation, prepareStorageReclamation }
  from './storage-reclamation-install.mjs';
import {
  platformTag, derivedRecipe, requireDerivedLayers,
} from './managed-derived-image.mjs';

const security = join(coreRoot, 'src/security');
const journal = `${resources.state}/state.json`;

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
export function managedResourceHost(confirmSource, engine = engineHost(), {
  prepareController = prepareSharedAccounts,
  installReclamation = installStorageReclamation,
} = {}) {
  const docker = (args, options) => engine.docker(true, args, options);
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
    // Only an explicit Claude request adds the Claude recipe, its pinned package
    // script and tool shell; the Codex inputs and their digest stay unchanged.
    async inputs(architecture, { claude = false } = {}) {
      const inputs = {};
      for (const name of Object.values(resources.recipes))
        inputs[name] = await boundedHostFile(join(security, name), 16384);
      for (const name of ['package.json', 'package-lock.json'])
        inputs[name] = await boundedHostFile(join(security, 'managed-npm', name),
          1024 * 1024);
      inputs['agent.Dockerfile'] = await boundedHostFile(
        join(security, 'agent.Dockerfile'), 16384);
      inputs['core-package.json'] = await boundedHostFile(
        join(coreRoot, 'package.json'), 16384);
      if (claude) {
        for (const name of [resources.claude.recipe, resources.claude.package,
          resources.claude.shell])
          inputs[name] = await boundedHostFile(join(security, name), 16384);
      }
      inputs.versions = agentVersions(inputs['agent.Dockerfile'],
        JSON.parse(inputs['core-package.json']), JSON.parse(inputs['package.json']),
        inputs[resources.claude.package]);
      inputs.native = await prepareAgentInputs(inputs['agent.Dockerfile'],
        architecture, docker);
      inputs.policy = await boundedHostFile(
        join(security, 'codex-security.apparmor'), 16384);
      return inputs;
    },
    async pristine() {
      for (const path of [resources.profile, resources.policy, resourcePreparationGate])
        requireThat(!await optionalStat(path), 'RESOURCE_FOREIGN_CONFIGURATION');
      requireThat(!await kernelPolicy(), 'RESOURCE_FOREIGN_POLICY');
      for (const kind of ['agent', 'hooks']) {
        for (const arch of ['amd64', 'arm64'])
          requireThat(!(await docker(['image', 'ls', '-q', platformTag(kind, arch)]))
            .trim(), 'RESOURCE_FOREIGN_IMAGE');
      }
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
      await prepareController(managedPaths, { preparation: true });
      await prepareStorageReclamation(installReclamation);
    },
    async image(kind, state, inputs, observe) {
      const marker = digest({ owner: state.owner, inputs: state.inputs, kind });
      const arch = state.architecture ?? 'amd64';
      const name = platformTag(kind, arch);
      if (kind === 'agent') requireThat(inputs.native?.platform === `linux/${arch}`,
        'RESOURCE_INPUT_IMAGE_PLATFORM_MISMATCH');
      let found = (await docker(['image', 'ls', '--no-trunc', '-q', name])).trim();
      if (!found) {
        requireThat(!observe, 'RESOURCE_IMAGE_RECONCILIATION_REQUIRED');
        let recipe = inputs[resources.recipes[kind]];
        if (kind === resources.claude.kind)
          recipe = resolvedClaudeRecipe(inputs[resources.claude.recipe],
            state.images.agent, inputs.versions?.claude);
        if (kind === 'agent')
          recipe = managedAgentRecipe(recipe, inputs.native, inputs.versions);
        if (kind === 'hooks')
          recipe = await derivedRecipe(recipe, state.images.agent, arch, docker);
        await engine.docker(true, ['build', '--no-cache', '--network=host',
          '--platform', `linux/${arch}`,
          '--label', `${resources.label}=${marker}`, '--tag', name,
          '--file', '-', security], { input: recipe, timeout: 30 * 60 * 1000,
          limit: 4 * 1024 * 1024 }).catch(() => {});
        found = (await docker(['image', 'ls', '--no-trunc', '-q', name])).trim();
      }
      requireThat(/^sha256:[a-f0-9]{64}$/.test(found),
        'RESOURCE_IMAGE_RECONCILIATION_REQUIRED');
      const rows = JSON.parse(await docker(['image', 'inspect', found]));
      const row = rows[0];
      requireThat(rows.length === 1 && row.Id === found &&
        linuxArchitecture(row.Os, row.Architecture) === arch,
      'RESOURCE_IMAGE_CONFLICT');
      if (kind !== 'agent')
        await requireDerivedLayers(row, state.images.agent, docker);
      requireThat(row.Config?.Labels?.[resources.label] === marker &&
        row.RepoTags?.includes(name), 'RESOURCE_IMAGE_CONFLICT');
      return found;
    },
    async availability(id, kind, inputs) {
      const versions = inputs.versions;
      const claude = kind === resources.claude.kind;
      requireThat(!claude || typeof versions.claude === 'string',
        'RESOURCE_INPUT_CONTRACT_INVALID');
      const probe = versionProbe({ go: versions.go }, versions,
        { codex: kind === 'agent', npm: versions.npm,
          claude: claude ? versions.claude : undefined });
      let output;
      try {
        output = await docker(['exec', '--user=1000:1000', id,
          '/usr/local/bin/node', '-e', probe]);
      } catch { requireThat(false, 'RESOURCE_NATIVE_EXECUTABLE_UNAVAILABLE'); }
      requireThat(output === 'NIBFIN_TOOLS_VERIFIED\n',
        'RESOURCE_NATIVE_EXECUTABLE_UNAVAILABLE');
      // All maintained images carry the Chromium runtime libraries. Probe only
      // those inputs here; this does not acquire an unrelated browser binary.
      try {
        output = await docker(['exec', '--user=1000:1000', id,
          '/usr/local/bin/node', '-e',
          browserRuntimeProbe(inputs.native.platform.slice(6))]);
      } catch { requireThat(false, 'RESOURCE_BROWSER_INPUT_UNAVAILABLE'); }
      requireThat(output === 'NIBFIN_BROWSER_RUNTIME_VERIFIED\n',
        'RESOURCE_BROWSER_INPUT_UNAVAILABLE');
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
