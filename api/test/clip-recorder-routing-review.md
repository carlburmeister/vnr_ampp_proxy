# Recorder routing workaround: evidence and regression review

## Evidence and scope before production changes

Baseline is PR12 commit `e661e1c0575b4ed46dfbab0d5d4b9268387dbcd0`.
The user confirmed wrong-source playback on both direct AMPP and proxied Densite
Clip Recorder, including the newest native version. The supplied HAR accepts
source settings and produces recordings, but the underlying recorder consumer
is routed to MiniMix Program while the app selects Preview or Kaleido.

The captured native JavaScript implements matrix destination GET, lock/unlock,
`requestroute` with source/destination UUIDs, and request-status GET. The repository
Router SDK also implements route request/status. Live unlock ownership and route
status vocabulary are not established by the HAR; acceptance steps below remain
required. No captured token or cookie will be replayed and no live route changed.

Scope: SPA Proxy backend only, using the existing Prepare/Record controls.
Inspect both repositories: Admin grants remain workload IDs/page types. Recorder
ownership is derived from authorized wrapper settings and matching engine
consumers. Sources use existing background resource visibility. No shared schema,
Admin or frontend contract change is planned; no broad matrix endpoint grant.

## Behaviors and compatibility checks

| Behavior | Evidence / planned verification |
| --- | --- |
| Selected source reaches engine | Real HTTP regression models the HAR: native settings do not change engine input. Require explicit route plus readback before/after preparation. |
| Recording starts only on verified input | Re-read settings, health and destination before Start; mismatch fails closed. |
| Native confirmations and errors | Preserve prepare state 3 (existing file), confirmation state 4 request, successful state 5, and native non-2xx responses. |
| Source/destination ownership | Fresh filtered producer list; consumer must uniquely match trusted recorder UUID and fabric. Browser recorder ID retargeting is rejected. |
| Lock restoration | Preserve original state, attempt restoration even if unlock outcome is ambiguous, and refuse Prepare after restoration failure. |
| Timeouts/cancellation | Bounded route/operation/HTTP waits; disconnected requests stop work; restorative relock uses a separate bounded cleanup signal. |
| Concurrency/resource bounds | Reject overlapping operations for a wrapper or engine; finite in-process active operation capacity; cleanup releases ownership. Multiple API processes retain an explicit coordination limitation. |
| Revocation/logout | Recheck persistent session identity/fingerprint throughout workflow; restorative relock alone may finish after revocation. No new command after logout. |
| Existing transports/Stop | Routing hook only handles recognized recorder settings POST, preparation POST and Start GET. Stop and unrelated application APIs preserve native forwarding. |

Baseline commands: full API unit/HTTP suites and build; new HTTP regression
against unchanged production; non-mutating targeted ESLint. Record final counts,
repeat compatibility commands after implementation, and review contracts and
safeguards before updating PR12.

## Implementation and limits

The hook recognizes the trusted workload package `GV.AMPP.Apps.Recorder` and only
handles settings POST, preparation POST and Start GET. Settings GET, Stop and
other application APIs retain native forwarding. Control method/query bypasses
are rejected, and encoded control paths receive the same input checks.

Each workflow uses fresh settings, recorder state and matrix data. Producer
visibility is applied through the existing matrix filter, including permitted
background sources whose UIs are denied. The input consumer must uniquely match
the server-reported recorder UUID and fabric. Settings POST cannot change that
binding. Fresh binding/state checks also run before native commands; preparation
success state 5 receives a post-prepare binding/input check. Internal lookups
discard browser validators and service-instance overrides.

Native 200/state 3 overwrite prompts, POST/state 4 confirmation, native errors
and Stop responses are preserved. A changed input/binding after preparation or
before Start returns 409. The proxy does not route a running recorder or silently
repair an input at Start, when the prepared format may no longer match it.

Defaults: route timeout 10 seconds, whole operation 60 seconds (configurable in
`.env.example`, maximum operation budget 120 seconds). Relock cleanup has a
separate five-second budget so it can finish after cancellation/revocation.
Failures are reported, including an explicit lock-restoration error; cleanup is
an attempt, not a guarantee of upstream availability. Invalidated bearer tokens
and cookie changes are persisted after failed workflows to preserve recovery.

Serialization is per wrapper and engine in one API process, with finite active
capacity and no unbounded pending queue. Multiple API processes or external AMPP
clients require shared coordination to provide atomic routing/start behavior.
AMPP can still finish an already-submitted operation after an HTTP cancellation;
the proxy prevents subsequent commands and performs bounded lock cleanup.

The route-status client recognizes string success states `Complete`, `Completed`,
`Success`, `Succeeded`, `Successful` and `Routed` (case-insensitive). Error text or
failure states are rejected; unknown states time out rather than count as
success. These labels and the matrix detail response still need live validation.

## Validation results

| Check | PR12 baseline | Updated |
| --- | --- | --- |
| Full unit suite | 29 suites / 323 tests passed | 29 suites / 324 tests passed |
| Full HTTP suite | 7 suites / 109 tests passed; 1 existing bootstrap failure | 8 suites / 145 tests passed; same bootstrap failure |
| API build | Passed | Passed |
| New routing HTTP cases | 29 failures / 5 passes / 2 skipped | All 36 passed |
| Transport deadline/cancel regression | 1 failure / 3 passes | All 4 passed in full unit suite |
| Targeted existing production ESLint | 41 existing errors | Same 41 errors; no added-line findings |
| New service and HTTP test ESLint | N/A | Zero findings |
| Diff whitespace | Clean | Clean |

The first 25-case regression was run before production edits (20 failed, 4
passed, 1 concurrency case skipped). The final regressions were also run in a
separate worktree at the unchanged baseline. Concurrency/cancellation cases are
skipped only there because the old code never reaches their routing gates; all
run against the implementation. The unchanged application-bootstrap failure is
`app.e2e-spec.ts`: missing `PLATFORM_URL`, followed by teardown of an uncreated
app. It is not counted as a pass. Lint was run without `--fix`; existing issues
and comments were preserved. The intentional relock-failure test emits an error
log while verifying the operation is refused.

## Final diff review

Reviewed recorder-only interception, trusted binding/source resolution, narrow
consumer selection, native command ordering/status passthrough, bearer selection
and 401 handling, persistent-session checks, timeouts/cancellation, cleanup and
resource bounds. General matrix route/lock APIs remain forbidden by the browser
policy. No existing comments or safeguards were removed. Optional transport
deadline/signal fields apply to recorder workflows; ordinary requests retain
their existing defaults. No dependency, Admin, schema or frontend changes.

## Live acceptance still required

1. Confirm the matrix detail and route-status response schemas against AMPP.
2. Select MiniMix Preview, prepare, and confirm recorder destination source UUID.
3. Record/play a short clip; repeat with Kaleido at a different picture size.
4. Confirm original lock state, overwrite confirmation, Stop and error recovery.
5. Verify failed routing, reset-on-prepare and input changes prevent Start.

The workaround changes a real recorder input when deployed. Keep it on the PR12
branch for this live acceptance; tests alone do not establish media correctness.
