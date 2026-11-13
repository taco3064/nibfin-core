import { releaseVersion } from './release-version.mjs';
import { repoPath } from './github-read.mjs';
import { digest, isSha, isDigest, isId, sha256, requireThat } from './identity.mjs';

export function releaseAssets(built) {
  requireThat(
    built?.manifest?.repository === 'taco3064/nibfin-core' &&
      isSha(built.manifest.commit) &&
      isDigest(built.manifestHash) &&
      built.manifestHash === digest(built.manifest) &&
      Buffer.isBuffer(built.bytes) &&
      built.sha256 === sha256(built.bytes),
    'INVALID_RELEASE_BUILD',
  );
  if (built.manifest.releaseVersion !== undefined)
    releaseVersion(built.manifest.releaseVersion);
  const pin = {
    repository: built.manifest.repository,
    commit: built.manifest.commit,
    ...(built.manifest.releaseVersion === undefined
      ? {} : { releaseVersion: built.manifest.releaseVersion }),
    archiveHash: built.sha256,
    manifestHash: built.manifestHash,
  };
  return [
    {
      name: 'nibfin-core.tar.gz',
      contentType: 'application/gzip',
      bytes: built.bytes,
    },
    {
      name: 'source-pin.json',
      contentType: 'application/json',
      bytes: Buffer.from(JSON.stringify(pin, null, 2) + '\n'),
    },
    {
      name: 'SHA256SUMS',
      contentType: 'text/plain',
      bytes: Buffer.from(`${built.sha256}  nibfin-core.tar.gz\n`),
    },
  ];
}

async function readReleaseTag(reader, root, version) {
  const ref = await reader.get(`${root}/git/ref/tags/${version}`);
  requireThat(ref.ref === `refs/tags/${version}`, 'RELEASE_TAG_CHANGED');
  let object = ref.object;
  for (let depth = 0; object?.type === 'tag' && depth < 4; depth++) {
    requireThat(isSha(object.sha), 'INVALID_RELEASE_TAG');
    const tag = await reader.get(`${root}/git/tags/${object.sha}`);
    requireThat(tag.sha === object.sha, 'RELEASE_TAG_CHANGED');
    object = tag.object;
  }
  requireThat(
    object?.type === 'commit' && isSha(object.sha),
    'INVALID_RELEASE_TAG',
  );
  return { ref, commit: object.sha };
}

export async function planRelease(reader, { version, built }) {
  const releaseVersion = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/;
  const suffix = /^(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/;
  const match = releaseVersion.exec(version);
  requireThat(
    match && suffix.test(version.slice(match[0].length)),
    'INVALID_RELEASE_VERSION',
  );
  const files = releaseAssets(built),
    repository = built.manifest.repository,
    root = repoPath(repository);
  const repo = await reader.repository(repository);
  requireThat(
    isId(repo.id) &&
      repo.full_name === repository &&
      repo.private === false &&
      !repo.archived &&
      !repo.disabled,
    'RELEASE_REPOSITORY_CHANGED',
  );
  const tag = await readReleaseTag(reader, root, version);
  requireThat(tag.commit === built.manifest.commit, 'RELEASE_SOURCE_CHANGED');
  const releases = await reader.list(`${root}/releases`);
  requireThat(
    !releases.some((release) => release.tag_name === version),
    'RELEASE_VERSION_ALREADY_EXISTS',
  );
  return {
    schemaVersion: 1,
    repository,
    repositoryId: repo.id,
    version,
    commit: built.manifest.commit,
    manifestHash: built.manifestHash,
    archiveHash: built.sha256,
    draft: true,
    assets: files.map((file) => ({
      name: file.name,
      size: file.bytes.length,
      sha256: sha256(file.bytes),
    })),
  };
}

// Only a trusted workflow creates a draft. No method publishes, replaces a tag,
// deletes an asset or retries an ambiguous effect. The caller supplies a local
// in-flight journal and a fresh native admission function, never an Agent result.
export class ReleaseDraft {
  #reader;
  #token;
  #fetch;
  #journal;
  #admit;
  constructor({ reader, token, fetcher = fetch, journal, admit }) {
    requireThat(
      typeof token === 'string' &&
        token.trim() &&
        typeof reader?.get === 'function' &&
        typeof journal?.run === 'function' &&
        typeof admit === 'function',
      'INVALID_RELEASE_ADAPTER',
    );
    this.#reader = reader;
    this.#token = token;
    this.#fetch = fetcher;
    this.#journal = journal;
    this.#admit = admit;
  }
  async create(plan, built) {
    const files = releaseAssets(built),
      bindingHash = digest(plan);
    requireThat(
      plan.schemaVersion === 1 &&
        isId(plan.repositoryId) &&
        plan.draft === true &&
        plan.repository === built.manifest.repository &&
        plan.commit === built.manifest.commit &&
        plan.manifestHash === built.manifestHash &&
        plan.archiveHash === built.sha256 &&
        digest(plan.assets) ===
          digest(
            files.map((file) => ({
              name: file.name,
              size: file.bytes.length,
              sha256: sha256(file.bytes),
            })),
          ),
      'RELEASE_PLAN_CHANGED',
    );
    const root = repoPath(plan.repository);
    let releaseId;
    const fresh = async () => {
      requireThat(
        (await this.#admit(plan)) === bindingHash,
        'RELEASE_ADMISSION_CHANGED',
      );
      return bindingHash;
    };
    const mutate = async (url, contentType, body) => {
      await fresh();
      const response = await this.#fetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(120000),
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': contentType,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body,
      });
      requireThat(response.ok, 'RELEASE_EFFECT_UNKNOWN');
      return response.json();
    };
    const outcome = await this.#journal.run(
      { operation: 'release', bindingHash },
      {
        admit: fresh,
        perform: async () => {
          requireThat(
            digest(
              await planRelease(this.#reader, { version: plan.version, built }),
            ) === bindingHash,
            'RELEASE_PLAN_CHANGED',
          );
          const release = await mutate(
            `https://api.github.com${root}/releases`,
            'application/json',
            JSON.stringify({
              tag_name: plan.version,
              target_commitish: plan.commit,
              name: plan.version,
              draft: true,
              prerelease: plan.version.includes('-'),
              generate_release_notes: false,
              body: [
                `Core source: ${plan.commit}`,
                `Archive SHA-256: ${plan.archiveHash}`,
                `Manifest: ${plan.manifestHash}`,
                '',
                'Complete required review and verification before publication.',
              ].join('\n'),
            }),
          );
          requireThat(
            isId(release.id) &&
              release.draft === true &&
              release.tag_name === plan.version,
            'RELEASE_IDENTITY_UNKNOWN',
          );
          releaseId = release.id;
          for (const file of files) {
            const asset = await mutate(
              `https://uploads.github.com${root}/releases/${releaseId}/assets` +
                `?name=${encodeURIComponent(file.name)}`,
              file.contentType,
              file.bytes,
            );
            requireThat(
              isId(asset.id) &&
                asset.name === file.name &&
                asset.size === file.bytes.length &&
                asset.state === 'uploaded' &&
                asset.digest === `sha256:${sha256(file.bytes)}`,
              'RELEASE_ASSET_UPLOAD_UNKNOWN',
            );
          }
        },
        readBack: async () => {
          const release = await this.#reader.get(`${root}/releases/${releaseId}`);
          requireThat(
            release.id === releaseId &&
              release.draft === true &&
              release.tag_name === plan.version &&
              release.target_commitish === plan.commit &&
              release.published_at === null,
            'DRAFT_READBACK_UNKNOWN',
          );
          const assets = await this.#reader.list(
            `${root}/releases/${releaseId}/assets`,
          );
          requireThat(
            assets.length === files.length &&
              files.every(
                (file) =>
                  assets.filter(
                    (asset) =>
                      asset.name === file.name &&
                      asset.state === 'uploaded' &&
                      asset.size === file.bytes.length &&
                      asset.digest === `sha256:${sha256(file.bytes)}`,
                  ).length === 1,
              ),
            'RELEASE_ASSET_READBACK_UNKNOWN',
          );
          return bindingHash;
        },
      },
    );
    return outcome.status === 'completed'
      ? { status: 'draft-created', releaseId, published: false, bindingHash }
      : outcome;
  }
}

export async function verifyPublishedRelease(reader, expected, download) {
  requireThat(
    expected?.repository === 'taco3064/nibfin-core' &&
      isId(expected.releaseId) &&
      isId(expected.repositoryId) &&
      isId(expected.publisherId) &&
      isSha(expected.commit) &&
      isDigest(expected.archiveHash) &&
      isDigest(expected.manifestHash) &&
      /^v[0-9][A-Za-z0-9.-]*$/.test(expected.version) &&
      typeof download === 'function',
    'INVALID_RELEASE_PIN',
  );
  const root = repoPath(expected.repository),
    repo = await reader.repository(expected.repository);
  requireThat(
    repo.id === expected.repositoryId &&
      repo.full_name === expected.repository &&
      repo.private === false,
    'RELEASE_REPOSITORY_CHANGED',
  );
  const path = `${root}/releases/${expected.releaseId}`,
    release = await reader.get(path);
  requireThat(
    release.id === expected.releaseId &&
      release.draft === false &&
      release.immutable === true &&
      release.tag_name === expected.version &&
      release.author?.id === expected.publisherId &&
      release.published_at,
    'RELEASE_NOT_IMMUTABLY_PUBLISHED',
  );
  const tag = await readReleaseTag(reader, root, expected.version);
  requireThat(tag.commit === expected.commit, 'RELEASE_SOURCE_CHANGED');
  const assets = await reader.list(`${path}/assets`),
    bytes = {};
  for (const name of ['nibfin-core.tar.gz', 'source-pin.json']) {
    const matches = assets.filter((asset) => asset.name === name);
    requireThat(matches.length === 1, 'RELEASE_ASSET_MISSING_OR_AMBIGUOUS');
    const asset = matches[0],
      limit = name.endsWith('.gz') ? 32 * 1024 * 1024 : 16384;
    requireThat(
      isId(asset.id) &&
        asset.state === 'uploaded' &&
        asset.size > 0 &&
        asset.size <= limit &&
        asset.browser_download_url ===
          `https://github.com/${expected.repository}/releases/download/` +
            `${expected.version}/${name}`,
      'UNTRUSTED_RELEASE_DOWNLOAD',
    );
    bytes[name] = await download(asset.browser_download_url, limit);
    requireThat(
      Buffer.isBuffer(bytes[name]) &&
        bytes[name].length === asset.size &&
        asset.digest === `sha256:${sha256(bytes[name])}`,
      'RELEASE_DOWNLOAD_CHANGED',
    );
  }
  const pin = JSON.parse(bytes['source-pin.json']);
  requireThat(
    pin.repository === expected.repository &&
      pin.commit === expected.commit &&
      pin.archiveHash === expected.archiveHash &&
      pin.manifestHash === expected.manifestHash &&
      sha256(bytes['nibfin-core.tar.gz']) === expected.archiveHash,
    'RELEASE_PIN_MISMATCH',
  );
  requireThat(
    digest(await reader.get(path)) === digest(release) &&
      digest(await readReleaseTag(reader, root, expected.version)) === digest(tag),
    'RELEASE_CHANGED_DURING_READ',
  );
  return {
    status: 'verified',
    releaseId: release.id,
    source: pin,
    archive: bytes['nibfin-core.tar.gz'],
  };
}
