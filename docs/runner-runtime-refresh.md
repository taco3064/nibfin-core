# Official Runner software maintenance

Nibfin's managed pool uses GitHub's supported externally maintained Runner mode.
The installed Worker dispatcher protects Controller credentials and admission;
GitHub's ordinary self-updater must not overwrite it. This is an implementation
constraint of this installation, not a missing GitHub scheduling guarantee.

An administrator outside both managed Runner services can inspect and refresh
their official software with the installed Core command:

```sh
node /opt/nibfin/core/bin/nibfin-core.mjs refresh-runner-runtime preview
node /opt/nibfin/core/bin/nibfin-core.mjs refresh-runner-runtime apply
node /opt/nibfin/core/bin/nibfin-core.mjs refresh-runner-runtime resume
```

Use Core's installed Node runtime when invoking these commands. The commands
accept only the shown mode; callers cannot choose a program, archive URL, source
directory, service, account or registration. Preview observes the offered
application and installed identity without changing the software or services.

This operation must not run in an Actions Job or job-completed hook on the pool
it could stop. Before acquiring maintenance admission, Core checks actual Linux
service/cgroup membership. A hook finishing its script does not prove that its
Runner Job has completed. Use the existing external administrator maintenance
route; this command does not create an ordinary-Job-to-root transport.

Core asks the adopted execution repository's Runner applications endpoint for
the current Linux package matching the verified architecture. It matches the
package URL and filename against authenticated `actions/runner` release metadata,
then verifies the published asset digest and actual executable architecture.
The repository applications endpoint is not assumed to supply a digest. No user
maintains a release version or checksum table for this operation. Public package
downloads do not receive the selected account token.

Maintenance uses existing serialization, pool admission and business/effect
settlement. It stages the verified package, records the existing service state,
closes its own admission marker and stops only the matched managed services after
genuine work is settled. The two existing Runner IDs/names, private settings,
credentials, work directories, provider, Core package and model/GitHub logins
remain in place. Official binaries and supporting package files are replaced,
the maintained Worker dispatcher is restored, and the installer publishes the
new shared identity for JavaScript startup and Python Worker verification.

After interruption, `resume` reads the same operation and actual filesystem/unit
state. Confirmed renames and identity publication are reused. Missing disposable
extraction is rebuilt from the same verified package; a failed observation is
never interpreted as an absent write. Modified unknown live contents preserve
the affected recovery material and report a specific pending result.

Each operation uses its own private temporary workspace under the maintained
runtime staging root. Existing recovery state binds that workspace's actual
filesystem identity and selected package. While admission is closed, the same
existing closure retains the registration binding, slot intents and original
service state needed to recover a lost state file. It is not another queue or
lock. A foreign closure is never removed. If both records are absent, normal
inspection starts a fresh operation from current files and service state rather
than guessing that a stopped service used to run.

After both installed software trees and registrations are verified, Core removes
only this operation's admission closure. It starts only services running when
the closure was acquired; a previously stopped service stays stopped. Owner
Issue pauses and notification pause state are untouched. Actual native service
readback establishes stop/start success, including after a lost response.

Software completion and continuation are separate. Once maintenance admission
and the credential lease have been released, Core directly invokes
`completeInstalledLifecycle()`. Its `dispatched`, `paused` or `pending` result is
reported alongside the runtime result. A continuation observation failure does
not repeat binary replacement or registration. Owned obsolete staging is removed
only after checking current use and references; uncertain cleanup is reported
separately and retains only material with an unresolved recovery/use purpose.
Cleanup checks known entry contents, ownership, mounts and executable, working
directory, mapped-file and open-descriptor references. Unknown/changed material
is retained with its path and reason. Only empty operation directories are
removed; another update uses a fresh workspace and does not wait on unrelated
old staging. Partial deletion is reconciled from actual remaining entries.

An error from the maintained GitHub reader reports `GITHUB_API_RETRY_PENDING`
with a safe `githubApi` cause: HTTP status, network failure or invalid response.
The command uses its existing pending exit status, including when admission or
initial discovery fails before an operation record exists. Existing phases and
confirmed file/metadata effects are preserved on a later read failure. Rerun
the same operation normally; this classification adds no sleep, timer or retry
loop. A secondary failure to save pending diagnostics does not replace the
original API cause. Continuation preserves the same safe cause without sending
execution back through completed software installation.

Source, ownership, account identity and explicit authorization refusals retain
their checks. Exception text or an HTTP-looking code alone is not an API-read
classification. Unknown dispatch/write effects remain their existing pending
operations; they are not converted into read failures or blindly sent again.
Diagnostics contain no credential, response body, URL or full resource path.

This refresh does not update Core, rebuild a pool, replace registrations, install
another Runner or create unattended cloud handoff. Core-only package deployment
uses its separate lifecycle. No timer, periodic credential check, polling service
or external monitor is installed by this command.

Official references:

- [Runner applications API](https://docs.github.com/en/rest/actions/self-hosted-runners#list-runner-applications-for-a-repository)
- [Self-hosted Runner software updates](https://docs.github.com/en/actions/reference/runners/self-hosted-runners#runner-software-updates-on-self-hosted-runners)
- [Service management](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/configure-the-application)
- [Job hook timing](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/run-scripts)
