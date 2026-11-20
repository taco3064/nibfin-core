# Managed upgrade continuation

Core's verified source package contains the public
`src/upgrade-continuation-contract.json` manifest. JavaScript consumers can
also read `consumerContract.managedUpgradeContinuation`. Its separately
packaged recipe table leaves the legacy Issue caller table unchanged. Render
the execution recipe with the already adopted GitHub member's numeric ID.
CLI proposes these maintained files through the normal one-PR-per-repository
publication path. Keep the assigned pool, members, protection and review
settings under their existing owners.

The installed Core manager and its fixed client are prepared through normal
Core CD or authorized source maintenance. Updating the manager does not
require the new caller workflows to exist. Read back the execution workflow
on the adopted execution repository's protected default branch before
promising automatically routed handoff. If this is its first publication,
finish the necessary native review and merge before it can accept dispatches.

## Private administrator contract

Send one JSON request over stdin to the verified fixed management bridge as
an outside-pool administrator. These calls use the existing private
selected-member authorization. A workflow or Runner account cannot invoke
prepare, bind, observe or proposal-free completion.

| `kind` | Other fields | Effect |
| --- | --- | --- |
| `upgrade-prepare` | `repositories` of numeric adopted repo IDs, `source` with existing Core package `repository`, `commit`, `manifestHash`, and `activation` | Establish or recover the original authorized operation. For same-source work, activation may be null. For source promotion, use the actual native Core CD context, `{runId, artifactId}`. |
| `upgrade-bind` | `operationId`, `repositoryId`, `pullNumber` | Read and record the actual managed PR ID, node ID and read-back URL. Confirm supported routing separately. |
| `upgrade-observe` | `operationId` | Re-read native PR identity and route and expose current phase evidence. |
| `upgrade-complete` | `operationId` | Complete authorized consumers whose current default-branch caller and route establish that no proposal is needed. Other consumers keep their review or native continuation state. |

The success envelope contains `schemaVersion`, `status` and `upgrade`. The
outer `status: complete` means the control request returned a typed response.
Read the nested fields before presenting completion.

After a promotion is observed as installed, `upgrade-prepare` can recover its
original operation for the same adopted repositories and source with null
activation. The original active proposal and phase results are preserved.

- `operationId`, `executionRepository`, `executionRepositoryId` and
  `proposals` identify the handoff. Each proposal includes the originating
  repository ID, PR number, native PR ID, node ID and read-back URL.
- `handoff` distinguishes pending, review-pending and confirmed routing.
  A prepared review route does not imply the PR merged or its execution ran.
- `installation` reports confirmed adoption independently of other work.
  `consumers` reports adoption and handoff per repository, including mixed
  operations where a ready no-change consumer completes while another PR is
  pending. A confirmed abandoned proposal allows direct completion only with
  fresh proof that the required caller and route are already current.
  `coreRunId` identifies existing or explicitly accepted Core maintenance
  when a verified compatible source transition remains queued.
- `readiness` reports required model-free VM readiness separately. The same
  runtime payload and guest workspace contract are used by real Writers. The
  readiness exercise verifies initialization, created tool output, source
  preservation and cleanup of the private guest. No model login or project
  data enters this request.
- A definite private startup diagnostic identifies unusable guest init or
  Python. Only the typed cause crosses the host boundary. Other startup exits
  preserve their original pending cause.
- `continuation` and optional `continuationResults` report the existing native
  lifecycle result, preserving Owner pause. Confirmed dispatch is separate
  from Issue delivery.
- `cleanup` records the separate shared-resource retirement result. Existing
  retirement verifies all consumer migrations before changing shared resources.
- Phase causes are sanitized diagnostic codes or GitHub observation failures,
  never raw process output or credentials.

## Native merge routes

On an ordinary merge, GitHub's merged pull-request event starts the
originating repository's notification caller. For a supported managed merger
using its repository's `GITHUB_TOKEN`, the merger explicitly dispatches the
now-visible notification workflow on its default branch with `pull_number`
after observing the successful merge. The repository token's permissions stay
within its own repository. The selected member's automatically managed
dispatch credential and adopted destination variable handle the cross-repo
notification to the maintained execution workflow. See GitHub's
[token event behavior](https://docs.github.com/en/actions/concepts/security/github_token)
and
[native dispatch trigger](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch).

The notification sends only repository and PR locators. The execution
workflow invokes the fixed installed client. The manager independently checks
current adopted policy, signed job identity, native Run/Job/Check Run/Runner
and maintained workflow source, and re-reads the original recorded PR on its
current default branch. Ordinary, foreign, closed-unmerged, revoked and
unbound proposals cannot authorize installation or dispatch.

Native Core maintenance retains compatible pool-promotion ownership. Same
source adoption refresh uses the existing guarded refresh. Existing
continuation observes confirmed effects before repeating writes. Retrying a
pending result uses the same operation and normal native workflow or CLI
entry after authoritative readback.
