# Actions task titles

Official Core runs put the operation first, followed by the actual target
`owner/repository#Issue`. Issue event runs also show the event action and label,
when applicable. CI shows its repository and PR or branch; deployment runs show
their repository and branch. Workflow names and identity-sensitive job names
remain stable so existing dispatch, retry and authorization continue working.

`Auto` means a single continuation run that may execute several stages. Its title
is fixed when GitHub starts the run; it is not a live stage indicator. Explicit
stage requests identify their stage, including Shape validation/publication,
Deliver, acceptance hooks, Accept, Review, Publish PR, Merge and Close.
The completed Core invocation records the stages it actually reached, including
repeated repair attempts, in the task result and Actions summary. Results reused
from earlier runs are not represented as freshly executed stages. A process that
does not return a final result cannot provide a completed-stage summary.

Retry check runs inherit the triggering run's title. A skipped check does not
mean a retry was attempted. GitHub's run status and the check's logs distinguish
the outcome; titles never claim success or authorize another attempt.

Target names are display-only. Dispatchers use information they already have,
and include the optional name only when the already-read receiver workflow
declares it. Older receivers continue accepting their existing input shape.
Older callers without a name remain valid. A forwarded Wake can show the target
from its existing event; other calls without a name display `repository ID N`
rather than incorrectly naming the execution repository as the target.

The maintenance rollout publishes the receiver's optional input before updated
installed producers use it. The summary helper is included in the Core package;
older installations still execute normally while awaiting their normal update.
No new credential, lookup, scheduler or admission prerequisite is introduced.
CD selects its previous successful deployment from native run and job data,
independently of the displayed title. Historical run titles remain unchanged.

Installed customer caller templates are maintained in `src/caller-recipes.json`.
The official Core Issue caller uses that same authoritative recipe. CLI consumes
the recipes through its existing install/update interfaces; title changes do not
replace those installation operations.
