# Managed Issue wake producer

The managed producer creates a notification locator. It grants no execution
permission and makes no claim about live eligibility, successful upload,
delivery, or fanout. CORE-6 must authenticate native workflow/run/attempt
observations and recheck current GitHub state before acting.

## Version 1 output

The maintained constants in `src/managed-wake.mjs` define artifact name
`nibfin-issue-wake-v1-<attempt>`, file `issue-wake.json`, schema version 1 and a maximum
of 4,096 UTF-8 bytes, including the trailing newline. The name is unique per attempt within
a native run; consumers must not accept an arbitrary
URL as the handoff. Normal Actions retention applies; this is no durable queue.

The producer projects only these fields:

| Field | Type and meaning |
| --- | --- |
| `schemaVersion` | Integer 1 |
| `runId`, `attempt` | Positive safe integers from the hosted environment |
| `event.action` | One of the eight native Issue actions in the source contract |
| `event.repository.id` | Positive safe integer repository ID |
| `event.repository.full_name` | Owner/repository name matching the environment |
| `event.issue.id`, `number` | Positive safe integer Issue database ID and number |
| `event.issue.node_id` | Bounded GitHub Issue node ID |
| `event.issue.state` | `open` or `closed`; context, never eligibility |
| `event.issue.updated_at` | UTC timestamp in native second precision format |
| `event.issue.assignees` | Array of projected actors for handler context |
| `event.issue.labels` | Only `pause` and `delivered` names |
| `event.sender` | Optional projected actor; required for Pause label events |
| `event.label.name` | Bounded changed label name for labeled/unlabeled events |

An actor has only a positive safe integer `id`, bounded `login`, and native
`type` (`User`, `Bot`, or `Organization`). Pause actor qualification remains a
downstream responsibility. Bodies, comments, URLs, credentials and unrelated
payload fields are never copied. Labeled notifications retain the existing
`scope`/`pause` selection; unlabeled events retain existing compatibility.
Closed notifications do not assert that the Issue was delivered.

## Caller and reusable workflow

The fixed `issue-managed` caller recipe selects managed mode explicitly. The
protected reusable workflow invokes the producer on the GitHub-hosted Runner
without a wake token and uploads only the resulting JSON. The upload action
fails if the file is missing. Managed mode does not schedule a self-hosted job.

The existing `issue` caller recipe selects legacy routing by omitting the mode.
Existing callers can keep using that recipe while managed artifact consumption
is developed. Legacy routing still requires its existing wake authorization.
Both recipes are subject to exact source verification.

The Core source package includes the producer, contract, caller recipes,
reusable workflow, Issue entrypoint and routing-output dependency.
