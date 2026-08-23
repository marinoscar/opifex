# Manifests that MUST be rejected

Each file is invalid for one stated reason, and the conformance suite asserts
both that it fails and _which_ keyword rejected it. A fixture asserted only to
"fail somehow" would keep passing after the schema stopped checking the thing
it was written for.

| Fixture                                         | Why it must be rejected                                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `names-a-runner-field-that-does-not-exist.json` | `unevaluatedProperties` — a capability the control plane will never read is worse than an absent one, because it looks like a declaration                                             |
| `streaming-fidelity-as-a-boolean.json`          | Fidelity is **graded**. A boolean cannot express `partial`, and a runner squeezed into true/false either loses its loop detection or claims one it does not have                      |
| `no-cost-reporting-without-saying-so.json`      | `reportsCost: false` requires `notes`. A budget ceiling nobody can enforce is worse than an absent one, so the limitation has to be stated rather than inferred from a missing number |
| `zero-concurrency.json`                         | A runner that will accept no work is not a runner. Zero here would route work to something that can never take it                                                                     |
| `no-branch-patterns.json`                       | An empty restriction is not a restriction. A runner must name what it may write to                                                                                                    |
| `key-with-spaces.json`                          | The key goes into a `Runner:` commit trailer, a branch name and a log line. A space breaks trailer parsing                                                                            |
