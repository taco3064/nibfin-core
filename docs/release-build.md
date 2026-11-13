# Local Core release build

From the maintained Core installation or checkout, run:

```sh
node bin/nibfin-core-release.mjs /path/to/core-main 1.2.3 /path/to/new-assets
```

Use the exact Node runtime declared by the source's `package.json` and
`.node-version` (currently Node 24.22.1; npm baseline 11.9.0). The interface uses
`/usr/bin/git` and Node's built-in gzip/archive implementation. No network, GitHub
credentials, tag context, interactive input or npm install is required to build.
The supported local invocation uses a filesystem with POSIX path semantics.

The source must be a clean Git checkout whose root is the supplied path and whose
current branch is `main`. Tracked changes and untracked files are rejected.
Ignored files cannot enter the committed-source archive. Operational files remain
excluded by Core's source packaging rules. The caller is responsible for obtaining
the current main checkout; the builder does not fetch or establish remote trust.
Use an existing canonical parent directory and a new output path outside the
source tree. Existing files, directories and symlinks are refused. Failed builds
remove their reserved output and temporary verification installation.

The version is canonical SemVer 2.0.0 without a `v` prefix, for example `1.2.3`,
`1.2.3-rc.1` or `1.2.3-rc.1+build.5` (at most 256 characters). Numeric core and
numeric prerelease identifiers cannot have leading zeroes.

Success exits zero and writes one JSON object to stdout:

```json
{"status":"verified-build","output":"/path/to/new-assets","repository":"taco3064/nibfin-core","commit":"<source commit>","releaseVersion":"1.2.3","archiveHash":"<sha256>","manifestHash":"<manifest digest>"}
```

The output contains exactly the maintained `releaseAssets` outputs:

- `nibfin-core.tar.gz`: committed public source and `nibfin-manifest.json`.
- `source-pin.json`: source identity, integrity values and `releaseVersion`.
- `SHA256SUMS`: SHA-256 for `nibfin-core.tar.gz`.

The requested public release version is `releaseVersion` in both the pin and the
embedded manifest. The manifest also records `developmentVersion` from the source
package. Package files and their versions are unchanged; no version-bearing source
bytes are transformed. Consumers must read `releaseVersion` for the public release
version and `commit` for source identity, rather than infer either from the
unchanged development package version. Existing unversioned packaging keeps its
original metadata format.

Before success, Core installs the archive in a disposable directory, verifies its
complete file set, modes and contents using the generated pin, and executes the
installed public CLI's `help` command. The checksum, pin and manifest describe the
actual archive. The source context is checked again before writing final assets.

Failures exit nonzero, write no success result, and emit JSON on stderr with
`status: "denied"` and a `code`, such as `INVALID_RELEASE_VERSION`,
`INVALID_RELEASE_SOURCE_CONTEXT`, `INCOMPATIBLE_RELEASE_SOURCE`,
`UNSAFE_RELEASE_DESTINATION`, `PROCESS_UNAVAILABLE` or `COMMAND_FAILED`.
Callers must require a zero exit and `status: "verified-build"` before consuming
assets; they must not consume output left by an interrupted process.

The E2E release coordinator can consume the three assets and JSON result directly.
Local verification establishes artifact consistency only. Independent validation,
publication authorization, live E2E, tag/Release creation and host upgrades remain
with their existing processes. This command performs none of those operations.
