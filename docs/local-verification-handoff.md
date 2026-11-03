# Local Codex handoff: Core #1 remaining verification

## Authority and constraints

Continue the existing `taco3064/nibfin-core#1` manual bootstrap. Read the latest
Proposal, Issue and actual main before work. Do not create new prerequisite
Issues, rewrite the architecture, claim protected self-delivery for manual #1,
or require a second human PR Approve. Independent Agent technical review and
current-source CI still apply. Public repository content is English.

Keep the eight manual Bootstrap Blocked-by edges unchanged. Do not add fake
scope/shaped/delivered labels to #1. Authorized cutover/Scope audit resolves those
edges only after the three bootstraps and external cutover criteria are met.
Full three-repository self-delivery is not an additional Core #1 release gate.

## Completed source work to verify first

- PRs #19–#23 established the runtime and corrected solo authority, single-commit
  rebase/closure, vanished merged-run PR links, and dependency lifecycle checks.
- `docs/wake-entry.md` describes the new dispatch-to-stage bridge and exact
  nested-workflow pins. Read its limits; it starts one stage, not the whole cycle.
- `package.json` prepares `0.1.0-rc.1`; this is a candidate identifier, not a
  published or accepted release. `private: true` prevents accidental npm publish;
  the approved distribution path is GitHub source archives and Releases.

Fetch latest main, run `npm ci --ignore-scripts` and `npm run verify` with the
repository-pinned Node/npm. Inspect current PR/CI evidence before changing code.
Use separate reviewed PRs for any fixes, never a direct feature push to main.

## Establish an actual authorized test environment

The Linux launcher is one backend, not a required user OS. Read
[host-environments.md](host-environments.md) first. Missing local capabilities
do not authorize disabling AppArmor or requiring another physical computer.

1. Inspect available local tools/OS and existing logins without printing or
   copying credentials. Do not assume local Codex login alone proves the product
   sandbox works. Current host launcher supports one manually adopted Linux host
   with its documented rootless Docker isolation; unsupported configurations
   must stop rather than disable safeguards. If local tooling cannot host that
   configuration, use an Owner-authorized remote test host.
2. Read `docs/host-launcher.md`, `docs/native-authorization.md`, actual sandbox
   source and `scripts/verify-live-*.mjs`. Verify the GitHub identity can lawfully
   read branch protections and historical merge enforcement, register/read the
   test Runner where needed, and perform only approved writes. The ChatGPT
   connector previously returned 403 for branch-protection reads; do not reuse
   that observation as proof that a newly authenticated local identity will fail.
3. Use the user's existing Codex subscription login through the supported local
   login flow. Never request a token in chat, put auth in GitHub artifacts/secrets
   without explicit authorization, or pass the privileged GitHub token into an
   Agent session. Install verified Core separately from candidate files and set
   the fixed `/etc/nibfin/host.json` adoption with private credential references.
4. Obtain all approval/Caller/Runner/workflow/CI pins from actual native resources.
   Do not fabricate rule-suite evidence or turn a label/event into a grant. A
   merged approval source and a suitable normal test Issue require Owner-approved
   scope; manual Core #1 is not that normal Issue. If no such target is already
   authorized, present a concrete small test proposal for Owner decision before
   creating or altering external Issues or approval policy.

## Execute and repair within Core #1

Install the pinned caller from `docs/wake-entry.md`, configure its adopted read
identity, and call it through the exact three Issue locator inputs. Capture the
native run/attempt, resolved stage/member, actual Runner job, signed innermost
workflow identity and admission outcome. Verify forged actor/source/locator and
unready prerequisites cannot admit execution. Avoid repeated platform-only tests.

Run at least an actual authenticated Shape and independent Validator execution,
using distinct execution/session identities and the installed production adapter.
Observe isolated credentials, blocked host access and process cleanup. Success
must come from real outputs and native resources, not fixture results. If a later
stage is needed to establish the claimed capability, drive its authorized entry;
do not infer full delivery from a successful Shape. Preserve Pending fences for
unknown writes or processes and reconcile before retrying.

Finish the missing thin Issue-event/dispatch and stage-continuation integration
only within already approved responsibilities. Core owns decisions; Action/CLI
must not duplicate policy. Do not claim that current single-stage dispatch proves
the whole automatic lifecycle. Record precise unresolved boundaries if actual
native evidence exposes a defect, and fix/review it in the same Core #1 scope.

## Candidate packaging and release

GitHub package CI builds `nibfin-core.tar.gz`, `source-pin.json`, `SHA256SUMS` from
the exact commit and tests installation. After the runtime/authority evidence is
sufficient, verify the candidate revision and version. The existing protected
`.github/workflows/release.yml` can plan or create an unpublished draft:

```sh
gh workflow run release.yml -R taco3064/nibfin-core --ref main \
  -f version=v0.1.0-rc.1 -f create_draft=false
```

Read its actual result before considering `create_draft=true`; never blindly
retry an unknown draft/upload effect. A candidate draft is not C17 acceptance.
Select the final version through reviewed source changes, independently check the
assets and applicable immutable-release settings, publish only with the Owner's
release authorization, then read back tag/source/publisher/assets/digests using
the existing `verifyPublishedRelease` contract. Do not assume `private: true`
blocks GitHub Releases or remove it merely to allow an accidental npm publish.

Return actual commit, run/job URLs, exact tested source, authentication/isolation
outcomes, remaining gaps, and release read-back. Keep Core #1 open until the Owner
has reviewed the completion evidence. Do not apply `delivered` to manual #1.
