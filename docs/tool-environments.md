# Project tool environments

Core's host-side `ToolEnvironmentPreparer` resolves ENV-01's normalized `tools`
object. ENV-04 owns applying the returned environment to an admitted Job; this
operation does not select Jobs, alter dispatch or switch a global environment.

```js
import { ToolEnvironmentPreparer } from './src/tool-environment.mjs';

// Installed Core supplies this endpoint and backend, never repository content.
const preparer = new ToolEnvironmentPreparer(
  { docker, socket }, { backend, baseImage },
);
const image = await preparer.prepare(projectConfig.tools);
// null means keep the installed default; otherwise image is a verified sha256 ID.
```

Omitted tools and `{}` return `null` without accessing Docker or installing
anything. Unknown names, malformed declarations and unsupported exact versions
fail before installation. No aliases, alternate patches or highest-version
selection are supported. Dependency manifests are not read.

The authoritative finite catalog is `src/tool-catalog.mjs`. Documentation is
checked against that catalog:

| Tool | Exact version | Acquisition image |
| --- | --- | --- |
| node | 22.15.0 | Official Node bookworm-slim |
| node | 24.22.1 | Official Node bookworm-slim |
| python | 3.13.7 | Official Python slim-bookworm |
| go | 1.27.1 | Official Golang bookworm |

Preparation implements **linux/amd64** and **linux/arm64** native Docker routes
on the existing Linux rootless or remapped rootful backend. The daemon must
match the host architecture; emulation does not establish support. The socket,
daemon resource and security checks still apply. Rootful validation also runs the native
AppArmor/namespace probe. No host tool installation, registry credentials or
privileged containers are required.

Core automatically composes the adopted Agent image with catalog tools on the
first job that requests them. The build copies files from the catalog images and
uses a temporary context with fixed wrappers. It executes no Dockerfile build
steps that require a network, including on a Runner without the default Docker
bridge. Registry access is required to acquire uncached catalog images. Selected
binaries live under `/opt/nibfin/project`. Development commands and offline hooks
search `/opt/nibfin/project/bin` first. Bootstrap Node, Codex and the Core proxy
retain their original runtime and PATH. The image's global PATH is unchanged.
Python supplies `python`, `python3`, `pip` and `pip3`; Go supplies `go` and `gofmt`;
Node supplies `node`, `npm` and `npx`.
The selected Go wrapper sets `GOTOOLCHAIN=local` to prevent automatic toolchain
switching from overriding the requested version.

Reusable Docker layers and compatible completed images are retained intentionally.
The cache address includes the maintained recipe, selected exact versions,
platform, fixed bootstrap versions and verification program. Property order does
not affect it. Distinct versions and changed recipes coexist. Cache lookup always
checks image metadata and executes exact version checks without networking before
returning an immutable image ID. Validation also exercises npm, npx, pip, pip3,
gofmt and Python's shared-library modules. Missing or incompatible cache metadata causes a
build. A failed live version check rejects the request. Core never prunes images
or replaces the installed default.

Failures report a bounded request or preparation phase diagnostic. Raw Docker or
installer output is excluded. A partial build is never published as successful;
a build timeout is a failed preparation even if Docker later retains its layers.
Owned validation containers are reconciled by unique name. Uncertain termination
returns `WRITER_TERMINATION_UNKNOWN` with the recovery target, so the caller must
retain the existing fail-closed recovery fence. No successful environment is
returned while cleanup is uncertain. Temporary build contexts are removed;
verified reusable images remain in Docker's cache.

## Verification

`test/tool-environment.test.mjs` tests trust boundaries, cache compatibility,
concurrency, failures and exact composition using simulated Docker observations.
The normal changed-test selector includes these tests.

On a Docker-capable test host with the existing supported backend, installed
AppArmor profile and seccomp fixture, run:

```sh
NIBFIN_CODEX_TEST_IMAGE="$VERIFIED_AGENT_IMAGE_ID" \
NIBFIN_CODEX_TEST_SECCOMP="$PWD/src/security/seccomp.json" \
  node scripts/verify-live-tool-environments.mjs
```

The existing isolation CI route runs this check. It invokes the production
preparation operation, prepares Node 22, Node 24 and a Python/Go/Node combination,
checks reuse and coexistence, runs offline hooks with project version assertions,
and exercises the real Codex adapter's sandbox and missing-login denial. It needs
acquisition access to Docker's official image service and the verified base
Agent image. It uses no real login or inference. Simulated tests do
not establish a Docker integration pass; hosts without Docker must report this
check as Unverified and obtain native CI/Acceptance evidence separately.

On the managed native Linux route, Agent Node/Go sources are resolved separately
from the existing per-architecture project-tool catalog. Project Node, Python and
Go retain their own immutable child references, platform cache keys and exact
version checks through the project PATH. The bootstrap Node/Codex PATH remains
fixed. Unknown platforms and unavailable pinned tools stop the affected request;
no version substitution or emulation is supported. Browser dependencies remain
project package/lockfile inputs: the managed Agent checks its Chromium libraries
and fonts without installing an unrelated browser for every tool request. Actual
browser launch is verified by the selected project's browser tests.
