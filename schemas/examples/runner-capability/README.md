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

## Invalid fixtures

`invalid/` holds manifests that MUST be rejected, each for a stated reason.
Asserting only that good manifests pass would leave a schema that accepts
everything looking identical to one that works.
