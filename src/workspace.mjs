import { constants } from 'node:fs';
import {
  mkdir,
  lstat,
  open,
  realpath,
  writeFile,
  readFile,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { command } from './process.mjs';
import { digest, sha256, isDigest, isSha, requireThat } from './identity.mjs';
import { validateIssueIdentity } from './approval-record.mjs';
import { sameCandidate, sameCandidateChanges } from './candidate-evidence.mjs';
import { safeCandidatePath, candidateContract } from './candidate-contract.mjs';

// Selective workspace adaptation: Core owns the bare repository outside the
// Agent mount. Capture runs only after the isolated writer has proven stopped.
export class CandidateWorkspace {
  #root;
  #git;
  #run;
  #issue;
  #env;
  constructor(root, issue, { git = '/usr/bin/git', run = command } = {}) {
    requireThat(
      process.platform === 'linux' && typeof process.getuid === 'function',
      'UNSUPPORTED_WORKSPACE_HOST',
    );
    validateIssueIdentity(issue);
    this.#root = resolve(root);
    this.#issue = structuredClone(issue);
    this.#git = git;
    this.#run = run;
    this.work = join(this.#root, 'work');
    this.#env = {
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      HOME: join(this.#root, 'home'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
    };
  }
  async #privateRoot() {
    const stat = await lstat(this.#root);
    requireThat(
      stat.isDirectory() &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o077) === 0 &&
        (await realpath(this.#root)) === this.#root,
      'UNTRUSTED_WORKSPACE_ROOT',
    );
  }
  async #command(args, input, env = {}) {
    const result = await this.#run(
      this.#git,
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.autocrlf=false',
        '-c',
        'protocol.file.allow=never',
        `--git-dir=${join(this.#root, 'repository.git')}`,
        `--work-tree=${this.work}`,
        ...args,
      ],
      { cwd: this.#root, env: { ...this.#env, ...env }, input },
    );
    return result.stdout;
  }
  async #fetch(commit, depth, localRepository) {
    await this.#command([
      ...(localRepository ? ['-c', 'protocol.file.allow=always'] : []),
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      `--depth=${depth}`,
      localRepository ?? `https://github.com/${this.#issue.repository}.git`,
      commit,
    ]);
    requireThat(
      (await this.#command(['rev-parse', 'FETCH_HEAD'])).toString().trim() ===
        commit,
      'FETCHED_COMMIT_MISMATCH',
    );
  }
  async #handoffRepository(name) {
    if (name === undefined) return undefined;
    requireThat(typeof name === 'string' && /^workspace-[a-f0-9]{64}$/.test(name),
      'INVALID_HANDOFF_WORKSPACE');
    const source = join(dirname(this.#root), name, 'repository.git');
    const stat = await lstat(source);
    requireThat(dirname(source) !== this.#root && stat.isDirectory() &&
      stat.uid === process.getuid() && (stat.mode & 0o077) === 0 &&
      await realpath(source) === source, 'UNTRUSTED_HANDOFF_WORKSPACE');
    return source;
  }
  async #safeTree(commit) {
    const tree = (await this.#command(['ls-tree', '-r', '-z', commit]))
      .toString()
      .split('\0')
      .filter(Boolean);
    requireThat(
      tree.every(
        (entry) =>
          /^(100644|100755) blob [a-f0-9]{40}\t/.test(entry) &&
          safeCandidatePath(entry.split('\t')[1]),
      ),
      'UNSUPPORTED_SOURCE_TREE',
    );
  }
  async prepare(base) {
    requireThat(isSha(base), 'INVALID_WORKSPACE_BASE');
    await this.#privateRoot();
    // No overwrite/reset of an earlier workspace; recovery must inspect it.
    await mkdir(join(this.#root, 'repository.git'), { mode: 0o700 });
    await mkdir(this.work, { mode: 0o700 });
    await mkdir(this.#env.HOME, { mode: 0o700 });
    await this.#run(
      this.#git,
      ['init', '--bare', join(this.#root, 'repository.git')],
      { cwd: this.#root, env: this.#env },
    );
    await this.#fetch(base, 1);
    await this.#safeTree(base);
    await this.#command(['read-tree', base]);
    await this.#command(['checkout-index', '--all']);
    await writeFile(join(this.#root, 'base'), base, { flag: 'wx', mode: 0o600 });
    return { base, directory: this.work };
  }
  async restoreAdoptedCandidate(pin, shapeBody) {
    await this.#privateRoot();
    requireThat(isSha(pin.head) && isSha(pin.parent) && isSha(pin.tree) &&
      isDigest(pin.candidateHash), 'INVALID_OPEN_PR_ADOPTION');
    const basePath = join(this.#root, 'base');
    const base = await readFile(basePath, 'utf8');
    requireThat(isSha(base), 'INVALID_WORKSPACE_BASE');
    await this.#command(['read-tree', base]);
    const modified = await this.#command([
      'diff', '--name-only', '--no-ext-diff', '--no-textconv', pin.parent, '--',
    ]);
    const untracked = await this.#command(['ls-files', '--others', '-z']);
    requireThat(modified.length === 0 && untracked.length === 0,
      'OPEN_PR_WORKSPACE_NOT_CLEAN');
    await this.#fetch(pin.head, 2, await this.#handoffRepository(pin.workspace));
    const tree = await this.#command(['rev-parse', `${pin.head}^{tree}`]);
    const parents = await this.#command(['rev-list', '--parents', '-n', '1', pin.head]);
    requireThat(tree.toString().trim() === pin.tree &&
      parents.toString().trim() === `${pin.head} ${pin.parent}`,
    'OPEN_PR_ADOPTION_CHANGED');
    await this.#safeTree(pin.head);
    await this.#command(['read-tree', '-m', '-u', base, pin.head]);
    await writeFile(basePath, pin.parent, { mode: 0o600 });
    const candidate = await this.capture(shapeBody);
    if (digest(candidate) !== pin.candidateHash) {
      const { changes, ...snapshot } = candidate;
      const diff = await this.#command([
        'diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', base, '--',
      ]);
      requireThat(digest({ ...snapshot, diffHash: sha256(diff) }) === pin.candidateHash,
        'OPEN_PR_CANDIDATE_MISMATCH');
    }
    return candidate;
  }
  async clearIgnoredDependencies(shapeBody) {
    await this.#privateRoot();
    requireThat((await realpath(this.work)) === this.work, 'UNSAFE_WORKSPACE_PATH');
    const obligations = shapeBody ? candidateContract(shapeBody) : null;
    const required = obligations
      ? [...obligations.artifacts, ...obligations.hooks].map(entry => entry.path)
      : [];
    const ignored = await this.#command([
      'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z',
    ]);
    const dependencies = ignored.toString().split('\0')
      .map(path => path.replace(/\/$/, ''))
      .filter(path => safeCandidatePath(path) &&
        path.split('/').at(-1) === 'node_modules' &&
        !required.some(file => file === path || file.startsWith(path + '/')));
    if (dependencies.length) {
      await this.#command([
        'clean', '-fdX', '--', ...dependencies.map(path => ':(literal)' + path),
      ]);
    }
  }
  async discardWriterGit(terminationHash) {
    requireThat(isDigest(terminationHash), 'WRITER_NOT_PROVEN_TERMINATED');
    await this.#privateRoot();
    requireThat((await realpath(this.work)) === this.work, 'UNSAFE_WORKSPACE_PATH');
    const path = join(this.work, '.git');
    const stat = await lstat(path).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return;
    requireThat(stat.isDirectory(), 'UNSAFE_WORKSPACE_PATH');
    // This is Writer scratch. Core uses its own bare repository outside /work.
    await rm(path, { recursive: true });
  }
  async #files(required) {
    // Reset to the approved base before enumeration so repeated captures cannot
    // turn previously untracked, now ignored files into tracked files.
    const base = await readFile(join(this.#root, 'base'), 'utf8');
    await this.#command(['read-tree', base]);
    const listed = (
      await this.#command([
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
      ])
    )
      .toString()
      .split('\0')
      .filter(Boolean);
    const tracked = new Set(listed);
    const paths = [...new Set([...listed, ...required])].sort();
    const files = [];
    let total = 0;
    await lstat(join(this.work, '.git')).then(
      () => {
        throw new Error('UNSAFE_WORKSPACE_PATH');
      },
      (error) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
    for (const path of paths) {
      requireThat(safeCandidatePath(path), 'UNSAFE_WORKSPACE_PATH');
      const target = join(this.work, path);
      const stat = await lstat(target).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) continue; // A tracked deletion is represented by the new tree.
      requireThat(
        stat.isFile() &&
          !stat.isSymbolicLink() &&
          (await realpath(target)) === target,
        'NONREGULAR_WORKSPACE_FILE',
      );
      const handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const before = await handle.stat();
        requireThat(
          before.isFile() &&
            before.nlink === 1 &&
            before.size <= 16 * 1024 * 1024 &&
            files.length < 10000,
          'UNSAFE_OR_OVERSIZED_WORKSPACE',
        );
        total += before.size;
        requireThat(total <= 64 * 1024 * 1024, 'WORKSPACE_SIZE_LIMIT');
        const bytes = await handle.readFile(),
          after = await handle.stat();
        requireThat(
          after.size === before.size &&
            after.mtimeMs === before.mtimeMs &&
            after.ctimeMs === before.ctimeMs &&
            bytes.length === before.size,
          'WORKSPACE_CHANGED_DURING_CAPTURE',
        );
        files.push({
          path,
          bytes,
          tracked: tracked.has(path),
          mode: before.mode & 0o111 ? '100755' : '100644',
        });
      } finally {
        await handle.close();
      }
    }
    return files;
  }
  async capture(shapeBody, duringRebase = false) {
    await this.#privateRoot();
    if (!duringRebase)
      await lstat(join(this.#root, 'rebase.json')).then(
        () => {
          throw Object.assign(new Error('REBASE_IN_PROGRESS'), {
            code: 'REBASE_IN_PROGRESS',
          });
        },
        (error) => {
          if (error.code !== 'ENOENT') throw error;
        },
      );
    const base = await readFile(join(this.#root, 'base'), 'utf8');
    requireThat(isSha(base), 'INVALID_WORKSPACE_BASE');
    const obligations = candidateContract(shapeBody);
    const files = await this.#files(
      [...obligations.artifacts, ...obligations.hooks].map((entry) => entry.path),
    );
    await this.#command(['read-tree', '--empty']);
    const index = [];
    for (const file of files.filter((file) => file.tracked)) {
      const object = (
        await this.#command(
          ['hash-object', '-w', '--no-filters', '--stdin'],
          file.bytes,
        )
      )
        .toString()
        .trim();
      requireThat(isSha(object), 'INVALID_BLOB_IDENTITY');
      index.push(`${file.mode} ${object}\t${file.path}\0`);
    }
    await this.#command(['update-index', '-z', '--index-info'], index.join(''));
    const tree = (await this.#command(['write-tree'])).toString().trim();
    requireThat(isSha(tree), 'INVALID_TREE_IDENTITY');
    const changes = (await this.#command([
      'diff', '--cached', '--raw', '--no-abbrev', '--no-renames', '-z', base, '--',
    ])).toString();
    const paths = (
      await this.#command(['diff', '--cached', '--name-only', '-z', base, '--'])
    )
      .toString()
      .split('\0')
      .filter(Boolean);
    requireThat(
      paths.length > 0 && paths.every(safeCandidatePath),
      'EMPTY_OR_UNSAFE_CANDIDATE',
    );
    const manifest = async (entries) => {
      const result = [];
      await mkdir(join(this.#root, 'artifacts'), { mode: 0o700 }).catch(
        (error) => {
          if (error.code !== 'EEXIST') throw error;
        },
      );
      for (const entry of entries) {
        const file = files.find((file) => file.path === entry.path);
        requireThat(file, 'REQUIRED_ARTIFACT_MISSING');
        const hash = sha256(file.bytes),
          target = join(this.#root, 'artifacts', hash);
        await writeFile(target, file.bytes, { flag: 'wx', mode: 0o400 }).catch(
          (error) => {
            if (error.code !== 'EEXIST') throw error;
          },
        );
        requireThat(
          sha256(await readFile(target)) === hash,
          'ARTIFACT_SNAPSHOT_CORRUPT',
        );
        result.push({ ...entry, sha256: hash, size: file.bytes.length });
      }
      return result;
    };
    return {
      repository: this.#issue.repository,
      repositoryId: this.#issue.repositoryId,
      issueId: this.#issue.id,
      base,
      tree,
      changes,
      paths,
      obligations,
      artifacts: await manifest(obligations.artifacts),
      hookSources: await manifest(obligations.hooks),
    };
  }
  async rebase(candidate, shapeBody, latestMain, timestamp) {
    requireThat(isSha(latestMain), 'INVALID_REBASE_TARGET');
    requireThat(
      sameCandidate(await this.capture(shapeBody), candidate),
      'REBASE_CANDIDATE_CHANGED',
    );
    if (candidate.base === latestMain) return { status: 'unchanged', candidate };
    // Save intent before changing Git's index/worktree. A crash is not permission
    // to discard another writer's state or retry from an assumed clean checkout.
    const state = {
      original: candidate,
      shapeHash: digest(shapeBody),
      latestMain,
      timestamp,
    };
    const committed = await this.commit(candidate, shapeBody, timestamp);
    await writeFile(join(this.#root, 'rebase.json'), JSON.stringify(state), {
      flag: 'wx',
      mode: 0o600,
    });
    await this.#command([
      'fetch',
      '--no-tags',
      '--no-recurse-submodules',
      '--depth=1',
      `https://github.com/${this.#issue.repository}.git`,
      latestMain,
    ]);
    requireThat(
      (await this.#command(['rev-parse', 'FETCH_HEAD'])).toString().trim() ===
        latestMain,
      'REBASE_FETCH_MISMATCH',
    );
    const entries = (await this.#command(['ls-tree', '-r', '-z', latestMain]))
      .toString()
      .split('\0')
      .filter(Boolean);
    requireThat(
      entries.every(
        (entry) =>
          /^(100644|100755) blob [a-f0-9]{40}\t/.test(entry) &&
          safeCandidatePath(entry.split('\t')[1]),
      ),
      'UNSAFE_REBASE_SOURCE',
    );
    await this.#command(['update-ref', 'HEAD', committed.head]);
    const env = {
      GIT_COMMITTER_NAME: 'Nibfin',
      GIT_COMMITTER_EMAIL: 'nibfin@users.noreply.github.com',
      GIT_COMMITTER_DATE: timestamp,
      GIT_EDITOR: '/usr/bin/true',
    };
    try {
      await this.#command(
        ['-c', 'core.bare=false', 'rebase', '--onto', latestMain, candidate.base],
        undefined,
        env,
      );
    } catch (error) {
      const conflicts = (
        await this.#command(['diff', '--name-only', '--diff-filter=U', '-z'])
      )
        .toString()
        .split('\0')
        .filter(Boolean);
      if (!conflicts.length) throw error;
      requireThat(conflicts.every(safeCandidatePath), 'UNSAFE_REBASE_CONFLICT');
      return {
        status: 'changes_required',
        code: 'DELIVER_REBASE_CONFLICT',
        paths: conflicts,
        latestMain,
      };
    }
    return this.#finishRebase(state, shapeBody);
  }
  async continueRebase(shapeBody, latestMain, terminationHash) {
    await this.#privateRoot();
    requireThat(
      /^[a-f0-9]{64}$/.test(terminationHash),
      'REPAIR_WRITER_TERMINATION_REQUIRED',
    );
    const state = JSON.parse(
      await readFile(join(this.#root, 'rebase.json'), 'utf8'),
    );
    requireThat(
      state.latestMain === latestMain && digest(shapeBody) === state.shapeHash,
      'REBASE_CONTEXT_CHANGED',
    );
    // Deliver resolves ordinary conflicts in its isolated work mount. Core
    // stages raw file bytes, with no candidate filters or executable Git hooks.
    await writeFile(join(this.#root, 'base'), latestMain, { mode: 0o600 });
    await this.capture(shapeBody, true);
    await this.#command(
      ['-c', 'core.bare=false', 'rebase', '--continue'],
      undefined,
      {
        GIT_COMMITTER_NAME: 'Nibfin',
        GIT_COMMITTER_EMAIL: 'nibfin@users.noreply.github.com',
        GIT_COMMITTER_DATE: state.timestamp,
        GIT_EDITOR: '/usr/bin/true',
      },
    );
    return this.#finishRebase(state, shapeBody);
  }
  async #finishRebase(state, shapeBody) {
    const head = (await this.#command(['rev-parse', 'HEAD'])).toString().trim();
    const parents = (
      await this.#command(['rev-list', '--parents', '-n', '1', head])
    )
      .toString()
      .trim()
      .split(' ')
      .slice(1);
    requireThat(
      isSha(head) && parents.length === 1 && parents[0] === state.latestMain,
      'REBASE_HISTORY_UNVERIFIED',
    );
    await writeFile(join(this.#root, 'base.next'), state.latestMain, {
      flag: 'wx',
      mode: 0o600,
    });
    await rename(join(this.#root, 'base.next'), join(this.#root, 'base'));
    const candidate = await this.capture(shapeBody, true);
    requireThat(
      candidate.tree ===
        (await this.#command(['rev-parse', `${head}^{tree}`])).toString().trim(),
      'REBASED_WORKTREE_CHANGED',
    );
    await unlink(join(this.#root, 'rebase.json'));
    const contentChanged = !sameCandidateChanges(candidate, state.original);
    return { status: 'rebased', head, candidate, contentChanged };
  }
  async hookBaseline() {
    await this.#privateRoot();
    return join(this.#root, 'repository.git');
  }
  async push(head, branch, token, guard, expectedHead = null) {
    requireThat(
      isSha(head) &&
        /^nibfin\/issue-[1-9]\d*-[a-f0-9]{12}$/.test(branch) &&
        typeof token === 'string' &&
        token.trim() &&
        typeof guard === 'function' &&
        (expectedHead === null || isSha(expectedHead)),
      'INVALID_CANDIDATE_PUSH',
    );
    const targetHash = digest({
      operation: 'commit-pr',
      repository: this.#issue.repository,
      repositoryId: this.#issue.repositoryId,
      head,
      branch,
      expectedHead,
    });
    const admission = await guard({ operation: 'commit-pr', targetHash });
    requireThat(
      admission?.targetHash === targetHash &&
        /^[a-f0-9]{64}$/.test(admission.bindingHash),
      'PUSH_ADMISSION_DENIED',
    );
    await this.#command(
      [
        'push',
        `--force-with-lease=refs/heads/${branch}:${expectedHead ?? ''}`,
        `https://github.com/${this.#issue.repository}.git`,
        `${head}:refs/heads/${branch}`,
      ],
      undefined,
      {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0:
          'AUTHORIZATION: basic ' +
          Buffer.from(`x-access-token:${token}`).toString('base64'),
      },
    );
    return { head, branch };
  }
  async commit(candidate, shapeBody, timestamp) {
    requireThat(
      sameCandidate(await this.capture(shapeBody), candidate),
      'CANDIDATE_CHANGED_AFTER_ACCEPT',
    );
    requireThat(
      typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)),
      'INVALID_COMMIT_TIME',
    );
    const env = {
      GIT_AUTHOR_NAME: 'Nibfin',
      GIT_AUTHOR_EMAIL: 'nibfin@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'Nibfin',
      GIT_COMMITTER_EMAIL: 'nibfin@users.noreply.github.com',
      GIT_AUTHOR_DATE: timestamp,
      GIT_COMMITTER_DATE: timestamp,
    };
    const head = (
      await this.#command(
        ['commit-tree', candidate.tree, '-p', candidate.base],
        `Deliver #${this.#issue.number}\n\nCandidate: ${digest(candidate)}\n`,
        env,
      )
    )
      .toString()
      .trim();
    requireThat(
      isSha(head) &&
        (await this.#command(['rev-parse', `${head}^{tree}`]))
          .toString()
          .trim() === candidate.tree,
      'COMMIT_TREE_MISMATCH',
    );
    return { head, tree: candidate.tree, base: candidate.base };
  }
}
