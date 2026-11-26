# Proposal rules in the Shape

These rules add to the Shape skill above. After the Issue is delivered, the e2e gate
reads the approved Shape's `Proposal rules:` line to choose which Proposal rules to test
again, so the line must be exact and machine-readable. The Proposal is the Notion page
named in the repository's agent instructions on product authority; read it with the
Notion tools, even where a stage input points to a repository path for the authority.

## The line

The Shape holds exactly one such line, in its Goal section whatever its heading, written
alone on its own line from the first column, with no bullet, emphasis, code formatting or
line break. For example:

```text
Proposal rules: R5.12, R5.14
```

After `Proposal rules: ` come the ids, each `R`, the section number, a dot and the rule
number (`R5.12`), separated by a comma and a space; or the single word `none`. List
every id on its own; write no ranges. Nowhere else in the Shape does a line start with
`Proposal rules:`.

## Shape Author

- List every Proposal rule whose behavior this change adds or changes, including behavior
  the plan changes through shared code, commands or workflows. List a rule marked
  〔不測：…〕 like any other; the gate decides what it tests. Write `none` only when the
  change alters no rule's behavior.
- A rule the change only relies on is cited under Binding decisions, not on this line.
- Start from the rules the Issue cites and add every other rule the investigation shows
  the change affects. A section reference such as `§5` is not an id: replace it with the
  ids of the rules in that section whose behavior the change adds or changes.
- Never identify a rule by a line number, a bullet position or a section alone. Do not
  list a rule the Proposal marks as deleted.
- In a revision, keep every id the previous proposed Shape listed, except one the Proposal
  does not have or marks as deleted.
- A behavior change the Issue asks for but no rule describes is an authority gap. Name it
  in Evidence; the gap does not by itself block the Shape, for the Author or the
  Validator.
- If the Proposal cannot be read, list the ids the Issue writes out one by one, plus every
  id a supplied Validator finding requires; say in Evidence that the Proposal was not
  readable, and continue. If the Issue cites any range or section, return blocked
  instead: the line cannot be complete without the Proposal.

## Shape Validator

- Return changes-required when the line is missing, appears more than once, breaks the
  format above, lists an id the Proposal does not have or marks as deleted, or misses a
  rule whose behavior the plan adds or changes. Name the ids; ask for `none` only when the
  line is missing or malformed and the plan changes no rule's behavior.
- A listed rule you think the plan does not change is not a reason for changes-required;
  testing one rule too many is cheap. Mention it only inside a changes-required result,
  as a finding that starts with "Context, not a fix item".
- Do not reverse what the previous Validator findings the stage supplies decided about an
  id unless you cite new evidence. An id they required that the revision dropped is still
  required.
- If the Proposal cannot be read, check only the format and that every id the Issue
  writes out one by one, and every id the previous findings required, is listed.

## PR review

Compare the diff with the approved Shape's `Proposal rules:` line. When the diff adds or
changes the behavior of a rule the line does not list, and that change is neither called
for by the plan nor a side effect of the work the plan calls for, it is a problem for
Deliver to remove; name the rule id. A change the plan calls for, or its side effect, is
not a problem, even when the line misses its rule.

Skip this comparison when the approved Shape has no `Proposal rules:` line, or when the
Proposal cannot be read.
