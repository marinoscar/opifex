# N. A statement of the decision, not the topic

- Status: Proposed
- Date: YYYY-MM-DD
- Issue: #N
- Epic: #N

<!--
Copy this file to `NNNN-short-slug.md`, where NNNN is the next unused number,
zero-padded to four digits. The heading number is written unpadded ("# 9.");
only the filename pads. See README.md for the numbering rule and the lifecycle.

Title the ADR with the decision itself — "Call GitHub with the platform fetch,
not an SDK" — rather than the area it covers ("GitHub HTTP client"). An index
of topics tells a reader what was discussed; an index of decisions tells them
what is true. Delete these comments as you fill the sections in.

`Issue:` is the discussion issue this decision came out of — filed with the
Decision proposal form — and it is not optional: the ADR is the durable
artifact, the issue is the conversation that produced it, and VISION §5 wants
both edges walkable. `scripts/check-provenance.mjs` fails CI on an ADR without
it. This PR should also carry `Closes #N` for the same issue; see README.md.
`Epic:` is the epic the work belongs to, or omit the line if there is none.

`Status:` is `Proposed` while the PR is open and `Accepted` when it merges. A
decision that is later reversed is not edited or deleted — see README.md.
-->

## Context

<!--
The forces, not the answer. What made this a decision rather than an obvious
next step: the constraint, the two things that could not both be true, the
VISION section that pins one side of it. A reader two years from now has none
of the context you have today, and this section is the only place they get it.

If there was no real tension, there is no ADR to write. Record the choice in
the commit message and move on.
-->

## Decision

<!--
What was decided, stated flatly and in the present tense — "Invoke the CLI as a
child process", not "we should probably invoke". Include the specifics that
make it checkable: the config key, the file it lives in, the exact command.
-->

## Consequences

<!--
What follows — including what gets worse. An ADR listing only benefits is a
sales pitch, and the next reader will discover the cost the expensive way.
State the deciding argument explicitly, so a future reader can tell whether it
still holds. Most reversals happen because the argument expired, not because
the decision was wrong when it was made.
-->

## Alternatives considered

<!--
Each real option, and the specific thing that disqualified it. This is the
section that stops the same debate being reopened every six months — and the
section that makes reopening it legitimate when someone can show the
disqualifying reason no longer applies. An alternative dismissed without a
reason is an invitation to relitigate.
-->
