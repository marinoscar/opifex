# Runner capability manifests — worked examples

Two runners at opposite ends of the observability range, which is the point
VISION §6 makes:

> Runners **declare** what they can do rather than pretending to be equivalent.
> Equal observability across vendors is not achievable. A common floor that some
> runners exceed is.

|                            | `claude-code-local`       | `batch-agent-cloud`                 |
| -------------------------- | ------------------------- | ----------------------------------- |
| Streaming fidelity         | `full`                    | `none`                              |
| Silence threshold it earns | 90 seconds                | 90 minutes                          |
| Loop detection (#55)       | possible                  | reports UNAVAILABLE                 |
| Rate-limit signal          | `structured`              | `none`                              |
| A blocked run              | parks with a dated resume | escalates                           |
| Cost reporting             | yes                       | no — ceilings are decorative        |
| Stability tier             | `stable`                  | `experimental` — never load-bearing |

The second is deliberately hypothetical. VISION §9 warns that building only the
streaming path _"guarantees discovering, six months later, that the seam was
fictional"_, so the schema is exercised against a runner that exceeds nothing
rather than only against the one that exceeds everything.

Note what the near-zero runner is still REQUIRED to say. It cannot report cost,
so the schema forces it to fill in `notes` — a missing number would leave the
operator to infer the limitation, and a budget ceiling nobody can enforce is
worse than an absent one because it looks like a control.

## Availability is not capacity, and neither is the enabled flag

`unavailable.json` is the third example: the same runner as the first, with its
binary out of reach. Note what it does NOT do — it does not drop
`maxConcurrency` to zero. It still has the two slots its operator configured and
will have them again the moment the CLI comes back; what it cannot do is use
them right now, and that is `available: false` with a reason attached.

Three fields carry three meanings, and the whole point is that they stay apart:

| Fact                           | Where it lives              | What an operator does about it |
| ------------------------------ | --------------------------- | ------------------------------ |
| A human turned this off        | `enabled` on the runner row | flip it back                   |
| It cannot work right now       | `available` + a reason      | fix what the reason names      |
| How much it can do when it can | `maxConcurrency`            | raise or lower a limit         |

Collapsing any two of them loses a distinction an operator needs. Saying "it
has no capacity" when the truth is "its binary is missing" sends somebody to
wait for a slot that was never the problem — which is exactly what happened
before this field existed (#253, #262): the zero-capacity manifest failed
validation, its runner was left unregistered, and the fleet read as empty.

`available` is absent from the first two examples on purpose. **Absent means
available**, so every manifest written before the field existed goes on meaning
what it meant, and a runner that never has an outage never mentions it.

## Invalid fixtures

`invalid/` holds manifests that MUST be rejected, each for a stated reason.
Asserting only that good manifests pass would leave a schema that accepts
everything looking identical to one that works.
