# Work-order examples

Worked examples of `schemas/work-order.schema.json`, validated in CI by
`apps/api/test/schemas/work-order.schema.spec.ts`.

They exist so the schema is checked against documents somebody would actually
write, rather than only against the hand-crafted rejections in the spec. Each
one covers a case the schema treats differently:

| File | What it demonstrates |
|---|---|
| `minimal.json` | Every required field and nothing else. Both ceilings explicitly `null`, `pathConstraints` empty, `needs` empty — the shape of "nobody set a limit", stated rather than omitted. |
| `constrained.json` | The full document: ceilings, path constraints, declared needs, decision references, issue title. |
| `retry.json` | Attempt 3 at the same issue and the **same base commit** — the identity and branch both carry `a3`, and the base is unchanged, because abandon-and-re-run means a fresh run against the same tree. |
| `own-infrastructure.json` | A different repository, a `needs` entry that constrains execution locus, and a base commit that is not the one every other example uses. |

Note that no example carries a runner. There is no field for one, and
`unevaluatedProperties: false` is what enforces that — see the `$comment` at
the foot of the schema.
