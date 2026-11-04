# PR 7 correction: pre-implementation regression review

Instructions: `AGENTS.md` from main `59aca70`. Compatibility baseline: unchanged
main `59aca70` (production code identical to `a83e6d4`). Defective PR head:
`7a0fcec`. This review was recorded before correcting production code.

## Existing contracts and evidence

| Behavior | Evidence and compatibility check | Required preservation |
| --- | --- | --- |
| Recovery from temporary failures | Browser comparison against a local HTTP server; six 503s followed by 204 | Retry remains possible; success resets pacing |
| Same-alias mailbox recreation | Captured AMPP SDK explicitly recreates the same ID after 404; browser comparison | Deliver 404 promptly; successful POST permits the next poll |
| XHR timeout/abort semantics | Real Chromium, native 50 ms timeout and DONE/abort/loadend events | Call native send immediately; do not synthesize events |
| Alias reclamation and 512-entry bound | Old main accepts a fresh mailbox after reclaiming 512 idle entries; original PR rejects it | Reclaim recorded-idle entries without evicting active tabs |
| Authorization, logout and revocation | Existing GVUI policy, session-expiry, session-merge and HTTP suites | No new grants, cross-session aliases or session resurrection |
| Concurrency | Session save queue and latest-record merging | Activity cannot move backwards; stale cleanup cannot delete renewed entries |
| Other workloads | Existing scope/token, rewriting and frontend tests | Pacing applies only to GVUI notification GETs |

## Selected design, before implementation

Remove the browser transport interceptor entirely. Delay only failed GVUI poll
responses (403 and 5xx) on the server, using bounded in-memory retry state,
cancellable finite timers, exponential backoff with jitter capped at five seconds.
Do not delay 401/404/410 recovery responses or successful responses. Do not
permanently block requests. Keep response status, body and headers intact. Reset
failure state on success or validated mailbox creation. This preserves the
upstream client's recovery behavior and native networking contracts without
implementing another XMLHttpRequest state machine.

Track mailbox `lastUsedAt` in session JSON, at most once per minute per active
alias. Persist activity before the upstream request so concurrent cleanup sees
the renewed alias. Under capacity pressure, reclaim aliases idle for 25 minutes
plus the one-minute activity-recording margin; do not expire quiet aliases when
capacity is available. Merge timestamps monotonically and enforce capacity
against the latest merged session, not only the request snapshot.

Legacy aliases have no activity evidence. Give them one idle-window migration
grace rather than infer inactivity from creation age. A completely full legacy
session may temporarily retain its capacity error during that grace; active
aliases must never be guessed idle. This limitation is explicit and tested.

## Scope and assumptions

Only SPA Proxy code, tests and documentation change. The Admin stores/defines
`user_sessions` but does not interpret GVUI alias JSON; no SQL schema/API contract
change is needed. MySQL deadlock handling and Flow Monitor/AMPP sender behavior
are separate work. AMPP's exact server TTL semantics remain unverified; this
correction does not depend on them. Retry state is per API process, not a
distributed rate limiter. Live AMPP multi-tab/long-session validation is pending.

## Baseline and updated results

Before production edits:

- Main `59aca70`: API build passes; `npm test -- --runInBand` passes 279 tests
  (including two new unchanged compatibility cases).
- Main: `node test/gvui-browser-compat.cjs` passes same-alias recovery (204),
  recovery after six 503s (204), native timeout and DONE/abort/loadend ordering.
- Original PR `7a0fcec`: the recorded-idle capacity case fails with 409; the
  existing session-merge compatibility cases pass. The same browser script
  reproduces pending same-alias/outage recovery, no native timeout, and abort
  callbacks at OPENED (1) instead of DONE (4).

After correction:

| Same compatibility case | Main baseline | Original PR | Corrected PR |
| --- | --- | --- | --- |
| Same-alias recreation | Next poll 204 | Remains pending | Next poll 204 |
| Recovery after six 503s | Next poll 204 | Remains pending | Next poll 204 |
| Native XHR 50 ms timeout | Fires | Does not fire while queued | Fires |
| Abort event state/order | DONE/readystatechange, abort, loadend | OPENED/abort, loadend | DONE/readystatechange, abort, loadend |
| Reclaim 512 recorded-idle aliases | Accepts new alias | 409 | Accepts new alias |
| Session/layout isolation and revocation | Pass | Pass | Pass |

The final browser harness was also rerun on main and the corrected code through
the real compiled API controller with a thin local HTTP adapter. Both report
the same four successful browser outcomes. Original-PR failure evidence came
from the earlier harness using the same browser scenarios and emitted bootstrap.
Both use controlled transport responses, not live AMPP.

- API production build passes; 28 unit suites / 296 tests pass.
- Six isolated HTTP suites / 51 tests pass with
  `PLATFORM_URL=https://ampp.invalid npm run test:e2e -- --runInBand`.
  Added HTTP cases cover pre-poll activity persistence, same-ID recreation,
  response preservation, local rejection, transport failure, disconnect,
  concurrent revocation, ordinary workloads and persisted legacy migration grace.
- New unit cases cover finite retries beyond six failures, bounded state,
  timer/listener cancellation, idle versus active reclamation, monotonic merges,
  stale cleanup, removed/recreated generations and concurrent capacity rejection.
- Web production build and all three web test suites pass.
- ESLint passes for new TypeScript files and the GVUI service. Modified legacy
  files have no findings on added lines; their existing findings remain (28 in
  the controller, session service and session tests combined, versus 29 on main).
  The response rewriter is identical to main, including existing lint findings.
- Test-inclusive `tsc --noEmit -p tsconfig.json` still fails with exactly the
  same four diagnostics as main: existing fixtures in `mysql-session.store.spec.ts`
  and `client-permissions.service.spec.ts`. Production compilation passes.

## Final contract and safeguard review

- No new fetch/XHR interception or synthetic completion events remain. Native
  networking starts immediately. Only failed responses receive the finite delay;
  success and AMPP's 404 recreation signal pass immediately. Original status,
  body and headers are preserved, including upstream transport-error handling.
- Session/layout checks, alias namespacing, current-permission refresh, logout
  safeguards and the 512-entry bound remain. Activity is saved before upstream
  polling and authorization is checked again after merging current session data.
- Cleanup requires recorded inactivity under capacity pressure. Legacy timestamp
  initialization is saved even before a full-session 409; otherwise every retry
  would restart the grace window. Concurrent renewal survives stale cleanup.
- Capacity is rechecked against the merged record. If concurrent creation exceeds
  it, latest session values are restored before throwing, preventing error-response
  auto-save from persisting an oversized candidate. Simultaneous upstream
  creations can still leave an unused upstream mailbox on a rejected merge;
  no unverified AMPP deletion protocol was added.
- No Admin/schema changes are required: its schema references `user_sessions`,
  but its PHP application does not interpret GVUI mailbox JSON. No uploaded HAR,
  logs, credentials or captured client bundles are included in the commit.

Remaining limits: retry state and the existing save queue are per API process.
The changes do not establish cross-process transactional session merging or fix
MySQL deadlocks. Activity recording adds at most roughly one update per minute per
active alias; observe database load. A full legacy session may return 409 for its
26-minute observation window. Live AMPP multi-tab, expiration and prolonged outage
acceptance is still pending. Reload tabs that loaded the original PR interceptor
after deploying the correction. These checks provide regression evidence, not a
guarantee that no other regression exists.
