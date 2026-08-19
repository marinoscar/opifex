<!--
Traceability starts at the issue, not the code (CLAUDE.md → "MANDATORY: Issue-Driven
Development"). Every PR must trace back to an issue, and agent-authored work must carry
the full provenance trailer block (VISION.MD §5) in its commit messages.
-->

## Summary

<!-- What changed and why, in a few sentences. -->

## Related issue

<!--
REQUIRED. Use a closing keyword (Fixes/Closes/Resolves #NNN) so the issue closes when
this PR merges. VISION.MD §5: "No PR without one — a single orphan puts a hole in the
graph, and holes are not detectable after the fact."
-->

Fixes #

## Type of change

- [ ] `feat` — new functionality
- [ ] `fix` — bug fix
- [ ] `refactor` — internal change, no behavior change
- [ ] `test` — add/adjust tests only
- [ ] `docs` — documentation only
- [ ] `chore` — tooling, deps, formatting, build, CI

## How this was tested

<!-- Commands run, what they covered, and what you observed. Include CI status if relevant. -->

## Provenance trailers

<!--
Required in the commit message(s) for agent-authored work. A human-authored PR may
legitimately have only `Issue:`. Verbatim block from VISION.MD §5:
-->

```
Work-Order: wo_opifex_312_a3f91c2_a1
Issue: #312
Decision: ADR-0042
Runner: claude-code-local@2.1.223
Run-Id: 018f2c31-...
Attempt: 1
```

## Checklist

- [ ] Tests added/updated for this change
- [ ] Docs updated if needed
- [ ] Commit messages follow Conventional Commits (`<type>(<scope>): <summary>`)
- [ ] Closing keyword present in "Related issue" above
