# Expiry-only renewal: regression evidence and rollout

Base: PR10 commit `5a7ef57ba3c0ed09f66d5cb956a2d7fd69e3bc70`.
This change is stacked on PR10 while that PR is open. Scope is item #2 only.

## Existing behaviors and evidence before production edits

| Behavior | Evidence | Required preservation |
| --- | --- | --- |
| Login creates a fresh session; logout deletes it | `auth.controller.ts`, existing lifecycle HTTP cases | Only login may INSERT; no renewal may recreate a row |
| Expiry/deletion during authorization is rejected | Existing lifecycle HTTP cases; conditional UPDATE predicates | Preserve 401/cookie clearing and reject revoked/expired rows even when skipping writes |
| Permission checks persist the recheck timestamp and changed grants | Auth service/guard and existing HTTP/unit tests | Ten-second checks and immediate data saves remain |
| Token, cookie, identity, mailbox and cache changes persist | Existing proxy/session/HTTP unit tests | Never throttle full-session saves or PR7's pre-poll activity persistence |
| Multiple tabs cannot shorten a newer expiry | Existing `GREATEST` SQL and concurrent-renewal HTTP cases | Database-side renewal condition, no shared authorization cache |
| Cookies and current-session responses use confirmed deadlines | PR10's delayed-finalization and lifecycle HTTP cases | A skipped renewal cannot publish an unpersisted deadline |
| Early HTTP/SSE headers can precede the final store callback | express-session 1.19.0 `onHeaders`/`res.end` implementation | Clamp the session cookie at serialization time; preserve native response methods/contents |
| WebSocket revalidation reads without renewal | WebSocket service's `getStoredSession` and tests | Store get and socket message/recheck paths must remain read-only |
| API errors and cancellation recover | API lifecycle tests and web session-expiry tests | No cached success after a database failure; preserve error/retry behavior |
| Cleanup has bounded work and releases its timer | Store unit cases | Retain the existing cleanup schedule, predicate, limit and close behavior |

Existing baseline: API 308 unit tests and 64 HTTP tests pass; API/web builds and
all three web test files pass. Test-inclusive TypeScript retains four fixture
diagnostics. No production source was edited for this baseline.

The new `session-renewal.e2e-spec.ts` fixtures can run on unchanged PR10 using
`SESSION_RENEWAL_BASELINE=true`. The flag is test-only and omits the not-yet-present
renewal middleware. Compatibility cases must pass; renewal budgets are expected
to fail because PR10 still writes on each expiry touch.

## Intentional change and dependencies

- Default expiry-only persistence interval: 60 seconds, configurable; zero is
  the compatibility mode that retains renewal on every touch.
- Idle expiry can be up to the configured interval earlier than eight hours
  after the last activity. Full data saves continue immediately and renew expiry.
- SQL reads may replace writes. This is a row-change/binlog optimization, not a
  promise to reduce total query count or a fix for cleanup deadlocks.
- The Admin repository references the same three-column `user_sessions` schema
  and does not interpret SPA session JSON. No Admin/schema changes are required.
- Conditional renewal must handle zero affected rows by distinguishing a live
  concurrently renewed row from a deleted/expired one. No SELECT FOR UPDATE or
  in-memory session-ID validity cache is needed.
- In-flight responses retain the normal race after their last database check.
  No new distributed full-session merge guarantee is claimed.

## Updated results and final safeguard review

Before production edits, the new fixture establishes eight compatible behaviors
on unchanged PR10. One additional protection case exposes a pre-existing gap:
an ordinary endpoint can return 200 if expiry occurs during authorization, because
the final failing touch happens after headers. This is recorded as a required
pre-response validity improvement, not a passing baseline behavior.

Five of the six renewal budgets fail on PR10, as expected: writes within the
interval, renewal before the boundary, early-header deadline precision,
cross-process duplicate renewals, and validation-read failure handling. The
deleted-row protection already passes and must remain intact.

## Implementation and safeguard review

- `touch()` first reads the live indexed deadline. Fresh sessions execute no
  UPDATE. A due renewal uses a conditional UPDATE that also checks freshness,
  so concurrent API instances cannot both advance the same deadline within the interval. A zero-row
  UPDATE triggers another read to distinguish concurrent renewal from expiry or
  revocation. `GREATEST`, expiry predicates and explicit-login-only INSERT remain.
- Full-session `set()` is never throttled and counts as renewal. Authorization
  rechecks, token/cookie changes, mailbox activity and permission changes retain
  their existing immediate saves; this is not one total session write per minute.
- Confirmed deadlines and completion markers are held in WeakMaps keyed by the
  request's Session object. They are not serialized and do not cache validity
  across requests or processes. Reusing a confirmed expiry preserves
  `cookie.originalMaxAge`, preventing cumulative shortening of the rolling TTL.
- PR10's poll helper now returns the deadline after persistence/validation, not
  the proposed unpersisted expiry. Its current-session handler still owns its
  save. Login/logout are explicitly excluded from generic renewal because they
  own creation/deletion and must work after the previous row is revoked.
- A global HTTP interceptor validates before handlers and, for ordinary JSON
  results, after slow handlers before headers. The two buffering proxy controllers
  also await confirmation immediately before writing their own responses. They
  check disconnects around this new await. Normal fast responses reuse the same
  request's confirmation; they do not add another SQL operation at each step.
- SSE is validated before streaming starts. Its individual messages do not invoke
  renewal SQL, and an already disconnected response is not renewed after a handler.
  Native `write`, `end`, `flushHeaders`, response bodies and event timing are not
  wrapped. Only the standard session cookie's Expires attribute is bounded at
  `setHeader`; its signed value, other flags and unrelated cookies are preserved.
- Store `get()` remains read-only except its existing expired-row cleanup. Raw
  WebSocket upgrades and periodic socket/session merge rechecks do not acquire
  automatic renewals. No cleanup timer, batch size, index, schema, dependency,
  Admin, SPA polling or AMPP transport changes are included.
- Zero interval bypasses the new interceptor/cookie behavior and retains expiry
  updates on each touch. Invalid/non-integer, negative and eight-hour-or-larger
  intervals fail configuration validation before a pool/timer is created.

## Validation results

| Check | Unchanged PR10 | Updated |
| --- | --- | --- |
| API unit suite | 308 pass | 313 pass, including five invalid-interval cases |
| Isolated HTTP suite | 64 pass | 91 pass across seven suites; original lifecycle cases retain explicit zero-interval compatibility mode |
| New compatibility fixtures | Eight initial cases pass before production edits; all 20 final compatibility cases pass when replayed on unchanged PR10 | All 27 new cases pass: 20 compatible behaviors, six budgets, one required protection |
| Three fresh poll/ordinary/early-header requests | Three expiry UPDATEs | Zero UPDATEs |
| 59,999 ms / 60,000 ms renewal boundary | Writes before the boundary | No write before the boundary; one renewal at the boundary |
| Two API instances renewing simultaneously | Two UPDATEs report a matched row | One freshness-gated UPDATE reports a match; a racing second SQL attempt can affect zero rows |
| Expiry during ordinary authorization | 200; final touch fails after headers | 401 with SESSION_EXPIRED and cookie clearing before handler execution |
| API/web production builds and web test files | Pass; three web test files pass | Pass; three web test files pass |
| Test-inclusive TypeScript | Four fixture diagnostics | The same four fixture diagnostics |

The final fixture also exercises the real Mini Mixer and Flow Monitor HTTP
controllers and real Nest SSE delivery with mocked AMPP services. It covers slow
ordinary/proxy responses, signed/unrelated cookies, automatic data saves,
read-only store rechecks, logout/login races, zero-interval fallback, temporary
database failures and recovery, disconnects, revocation and concurrent later expiry.

Production builds and all three web test files pass. Test-inclusive TypeScript
output matches the baseline exactly: four existing fixture diagnostics in
`mysql-session.store.spec.ts` and `client-permissions.service.spec.ts`. New source
and HTTP fixtures pass ESLint; changed legacy files retain pre-existing findings,
with none on added lines.

The original store/lifecycle fixtures use an explicit zero interval so their
per-request eight-hour/write-count expectations remain a rollback compatibility
suite. The new renewal fixture uses the default positive interval and the actual
interceptor/cookie middleware. Its SQL adapter models primary-key reads and
conditional UPDATEs; it is not evidence of actual MySQL isolation/locking costs.

Repeatable checks:

```sh
cd api
npm run build
npm test -- --runInBand
PLATFORM_URL=https://ampp.invalid npm run test:e2e -- --runInBand
npx tsc --noEmit -p tsconfig.json
cd ../web
npm test
npm run build
```

For baseline comparison, copy `session-renewal.e2e-spec.ts` into PR10's base
checkout and run the HTTP command with `SESSION_RENEWAL_BASELINE=true` and
`--testPathPatterns=session-renewal --testNamePattern=compatibility`.
Run the budgets separately with `--testNamePattern='renewal budget'`; five of
the six budgets are expected to fail there. The separate required-protection
case also fails there with 200 instead of 401, as documented above.

## Rollout and remaining limits

Rebuild/restart the API. The default is `SESSION_TOUCH_INTERVAL_MS=60000`; choose
zero and restart to restore renewal on each touch. No database migration, Admin
deployment or frontend rebuild is required for the feature. Existing live
sessions are loaded from their current indexed expiry.

Idle expiry may occur up to the configured interval earlier than eight hours
after the last activity. Full saves can still happen every ten seconds for the
authorization-check timestamp; reducing those saves is a separate optimization.
Reads can replace writes, and simultaneous stale reads can still issue multiple
conditional UPDATE statements even though only one matches the freshness predicate.
The adapter records affected/matched rows; those are not measurements of MySQL
physical row changes or binlog events. Total query
count, query latency and binlog byte reduction are not guaranteed.

Live MySQL locking/load, production AMPP acceptance and binlog-byte savings remain
unverified. The existing cleanup/renewal deadlock mechanism and distributed
full-session merge races are not fixed. An in-flight request still has the normal
revocation race after its final confirmed database operation; the next request
revalidates. Long-lived streaming responses cannot update cookies after headers
have been sent, and their frames do not extend session lifetime. Passing checks
provide regression evidence, not a guarantee of no other regressions.
