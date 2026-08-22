# 6. Invoke `claude-code-local` as a subprocess, not through the Agent SDK

- Status: Accepted
- Date: 2026-08-22
- Issue: #61
- Epic: #18

## Context

#61 names this as the first decision the runner forces, and says why it cannot
be deferred:

> The invocation mechanism — headless CLI process vs the Agent SDK — is the
> first choice this issue forces, and it shapes event capture, cancellation and
> concurrency.

Both are real options. The CLI runs headless and emits a documented streaming
JSON event format; the SDK gives typed events in-process with no process
management at all. The SDK is the more comfortable API by some distance.

## Decision

**Invoke the CLI as a child process**, one process group per run, and parse its
streaming JSON output.

```
claude -p --output-format=stream-json --verbose
```

Cancellation is `SIGTERM` to the **process group**, then `SIGKILL` after a
grace period. Concurrency is the number of live child processes.

## Consequences

**The deciding argument is isolation, not ergonomics.** Opifex is a supervisor.
VISION §8 makes the runner never-trustable and §9 makes killing a silent run the
watchdog's core move — so the two properties that matter most are:

- **A crash in the runner must not take the supervisor with it.** In-process,
  an SDK bug, an unhandled rejection or a memory blow-up lands inside the thing
  whose entire job is noticing that runs have failed. A supervisor that dies
  alongside the run it was supervising is worse than no supervisor, because
  nothing is left to escalate. As a subprocess it is an exit code.
- **Cancellation must not be cooperative.** `kill(-pgid, SIGTERM)` is
  unconditional and verifiable; the process is gone or it is not. An in-process
  cancel asks the misbehaving component to please stop — and by the time the
  watchdog is cancelling, "misbehaving" is exactly what has been established.
  #61 requires cancellation to "actually terminate work, and not leave orphaned
  processes", which is a statement about process groups.

**It keeps the capability manifest honest.** The manifest already declares
`invocationModel: 'process'` and `executionLocus: 'own_infrastructure'`.
Choosing the SDK would make the first of those false, and #61 is explicit about
what that costs: *"overstating it produces a control plane that trusts signal it
is not actually receiving."* The manifest is a declaration, and a declaration
that does not match the mechanism is the one kind of lie this design cannot
absorb.

**It is the shape a second runner will also have.** VISION §6 argues runners
differ in invocation model, and §3.7 says build one well and do not build the
second until it is needed. A subprocess boundary is the most portable of the
three invocation models — another CLI-shaped runner slots in behind the same
seam with different argv. An SDK integration would have to be unpicked first.

**The cost is parsing, and it is real.** `stream-json` is line-delimited JSON on
stdout, and the runner has to tolerate partial lines, interleaved stderr, and
a format that can gain fields between CLI versions. That work lands in the
event-mapping slice of #61 rather than being avoided:

- Parse line-by-line, buffering an incomplete trailing line.
- Map to the six normalized types (#33) and **drop what does not map**, rather
  than inventing a type. An unmappable line is logged once per run, not
  escalated: a new CLI event type is a version skew, not a stalled run.
- Never let a parse failure kill the run. A run producing output nobody can
  read is still a run, and git-derived liveness (#52) still sees its commits —
  which is the second liveness source earning its keep.

**Concurrency becomes an OS-level fact.** The declared ceiling is enforced by
counting live children, and it is externally checkable with `ps`. VISION §11
notes automated runs compete with interactive use for one subscription quota,
so a ceiling that can be verified from outside the process is worth more than
one held in a variable.

**What this does not decide.** Whether the child runs on the host, in a
container, or in a sandbox is a separate question (#113 touches it). The
subprocess boundary is compatible with all three; the SDK is compatible with
the first only.

## Alternatives considered

**Agent SDK, in-process.** Typed events with no parsing, and materially less
code. Rejected on isolation: it puts the supervised workload inside the
supervisor, and makes cancellation a request rather than a signal.

**A long-lived CLI daemon, one process for many runs.** Fewer process starts.
Rejected because it re-couples runs to each other — one run's crash takes its
neighbours, and per-run cancellation stops being a kill. It also makes the
concurrency ceiling unobservable from outside again.
