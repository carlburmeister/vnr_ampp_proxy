# Clip Recorder subscription regression review

## Scope and evidence before production changes

Base: `404b4e52e7b076c50724b45e4c2c8bda0b8cfc9a` (main).

The supplied direct HAR accepts the POST subscription to
`gv.fabric.recorder.<recorderId>.#` (204), delivers recorder `info` notifications
including `state: prepared`, and records successfully. The proxy HAR rejects
the subscription with 403 `AMPP API endpoint is not allowed`, although settings
and preparation succeed. It receives no recorder notifications. The recorder ID
differs from the workload ID and stays constant across the captured profile
changes. Neither HAR proves ID stability after workload recreation.

The initial GET `recordingsettings` completes before the subscription. The API
controller already saves changed session data before sending its upstream
response. Learn the association only from that successful upstream GET, keyed by
the workload in its path. Browser POST bodies and echoed POST responses must not
establish grants. Existing sessions can learn the association on recorder reload.

## Compatibility boundaries

| Behavior | Evidence / verification |
| --- | --- |
| Recorder subscription and prepared event | New isolated HTTP regression reproduces the captured sequence through the real policy, proxy, controller, filters and session merge. Live button behavior remains a manual check. |
| Mailbox, method, query and workload checks | Existing policy and resource visibility tests plus new rejection cases; only the recorder topic allowlist changes. |
| Recording format changes | Direct HAR and HTTP test; settings POST must preserve the previously learned association. |
| Concurrent tabs and association replacement | New session tests and concurrent HTTP settings requests; merge by workload and retain newer stored values when a stale request conflicts. |
| Permission refresh/revocation and logout | Existing session/auth tests plus new recorder-specific cases. Clear learned IDs on authorization rebuild; do not merge data from revoked permissions or recreate deleted sessions. |
| Recovery, cancellation, timeouts and cleanup | Existing GVUI polling, expiry/renewal, token, transport and session suites. No transport, retry, cancellation or renewal code changes. |
| Resource bounds | One validated UUID per workload, read only through already-authorized workload APIs; replacing an ID does not accumulate old grants. |
| Admin/database compatibility | Admin grants remain workload IDs (`workload_id`, `page_type`); recorder associations are derived runtime session data. No Admin, schema, API contract or frontend changes. |

The session merge retains the existing in-process save queue and session-store
semantics. This change does not introduce distributed compare-and-swap for
multiple API processes.

## Validation

Before production edits: existing unit suite **29 suites / 313 tests passed**;
API build passed. Existing HTTP suite: **6 suites / 90 tests passed**; the
unrelated `app.e2e-spec.ts` bootstrap test fails because `PLATFORM_URL` is unset
(its teardown also fails because bootstrap never created the app).

Final new tests against unchanged production code in an isolated baseline
worktree: **7 unit failures / 32 passes** and **6 HTTP failures / 13 passes**.
Failures demonstrate missing capture, subscription
authorization, session persistence/merge, and authorization-reset handling.
Rejection cases and existing compatibility tests already pass.

| Check | Baseline | Updated |
| --- | --- | --- |
| `npm test --prefix api -- --runInBand` | 29 suites / 313 tests passed | 29 suites / 323 tests passed |
| `npm run test:e2e --prefix api -- --runInBand` | 6 suites / 90 tests passed; 1 bootstrap failure | 7 suites / 109 tests passed; same 1 bootstrap failure |
| New recorder HTTP suite | 6 failed / 13 passed | All 19 passed |
| Session/auth suites with new cases | 7 failed / 32 passed | All 39 passed as part of full unit run |
| `npm run build --prefix api` | Passed | Passed |
| ESLint on five changed production files | 195 existing errors | Same 195 errors; no findings on added lines |
| ESLint on new HTTP test | N/A | Passed |
| `git diff --check` | Clean | Clean |

Lint was run directly without `--fix` to avoid reformatting existing code.
Existing unit-test files also have baseline lint issues; added test lines were
checked separately. The unchanged application-bootstrap failure is not counted
as a passing test. No live environment or database was substituted to hide it.

## Diff review

Five production files change: upstream ID capture, a session type field, one
scoped topic rule, session merge registration, and authorization-reset cleanup.
Existing comments and checks are retained. Recorder IDs replace, rather than
accumulate, within each workload; a conflicting stored association wins over a
stale response. No recording commands, format handling, transport, token choice,
poll backoff, response filter, timeout, cleanup timer, or database schema changes.

## Manual acceptance after deployment

1. Reload the authorized Clip Recorder; inspect GET `recordingsettings`.
2. Confirm its recorder subscription returns 204.
3. Set a new clip name; confirm preparation succeeds and the mailbox receives
   `gv.fabric.recorder.<recorderId>.info` with `state: prepared`.
4. Confirm Record enables, recording starts/stops, and frame updates arrive.
5. Change profile and repeat; confirm another workload's recorder remains denied.

The independently identified framecache/discovery preview issues are outside
this PR. No live AMPP credentials or browser session are available in the tests.
