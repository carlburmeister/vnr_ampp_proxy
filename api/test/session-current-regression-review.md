# Current-session persistence: regression evidence

Scope: item #1 only, based on main `2c40532312cdb4836078f460b03813fe5e61350e`.
The baseline review below was completed before changing production source.

## Pre-change behaviors and evidence

| Behavior | Evidence on unchanged main | Required contract |
| --- | --- | --- |
| A visible session poll renews an eight-hour session | `session-expiry.e2e-spec.ts`; `session-cookie.ts` | Persist renewal before returning the deadline; retain cookie flags and `no-store` |
| Permissions are refreshed, including unchanged recheck timestamps | `AuthService.refreshSessionAuthorization`, `SessionAuthGuard`; added HTTP case | Preserve the ten-second interval and persist refreshed data before response |
| Logout, expired/deleted sessions and deleted accounts are rejected | Existing session-expiry HTTP cases and store predicates | No INSERT/upsert during renewal; retain 401, cookie clearing and conditional UPDATE |
| Revocation between loading and persistence cannot resurrect a row | Existing HTTP cases with and without refreshed data | Conditional write must still reject the missing row |
| Another tab's later expiry is preserved | Store `GREATEST` predicate; added concurrent-renewal HTTP case | Never shorten the stored deadline |
| Mutations after controller completion are saved | Added interceptor HTTP case | Never suppress full saves for later genuine changes |
| Other endpoints save authorization before running their handler | Added ordinary-endpoint HTTP case | Deferral is explicit and restricted to current-session |
| Other endpoints still save mutations after a poll | Added ordinary-endpoint HTTP case; existing proxy/token/mailbox tests | No session-ID/process-wide suppression |
| Temporary authorization/write failures can recover | Existing authorization-failure case; added write-failure HTTP case | Return an error for failed persistence, retain a live session, permit subsequent retry |
| Native polling, cancellation, resume and protected UI behavior | Web `sessionExpiry.test.ts` and existing GVUI HTTP/unit compatibility tests | No frontend timing, API shape or AMPP transport changes |

## Baseline before production edits

- Existing API unit suite: 29 suites / 308 tests pass.
- Existing isolated HTTP suite: 6 suites / 53 tests pass.
- API and web production builds pass; all three web test files pass.
- Before production edits, all 18 session lifecycle compatibility cases pass
  (the ten original cases plus eight added cases). The final fixture adds one
  successive-poll case; the same final fixture was replayed in a separate
  worktree of unchanged main and all 19 compatibility cases pass there too.
- The two write-budget assertions fail as expected: two UPDATEs without refresh,
  three UPDATEs when refresh saves. Both expect one UPDATE in the correction.
- Test-inclusive TypeScript checking reports four existing fixture diagnostics in
  `mysql-session.store.spec.ts` and `client-permissions.service.spec.ts`.

The write-budget cases are intentionally separate: unchanged main issues two
UPDATE statements without an authorization refresh and three when refresh saves.
The target is one successful UPDATE per ordinary poll, preserving full saves for
genuinely changed authorization or later session mutations.

## Dependencies, assumptions and limits

- express-session 1.19.0 is the lockfile version. Its response-end touch and
  cookie renewal must be exercised through actual middleware, not mocked calls.
- The Admin schema has the same `user_sessions` columns. Its PHP/JS application
  does not read the SPA session JSON. No Admin or schema changes are needed.
- Conditional updates and `GREATEST` remain the concurrency/expiry safeguards.
  Existing cross-process full-session merge races are not fixed by this change.
- SQL-adapter HTTP tests do not establish live MySQL locking, replication or
  binlog byte savings. No production database or AMPP credentials are used.
- Completion tracking must be request/session-object scoped and weakly held;
  failed persistence must never install a successful-write marker. Later genuine
  changes must still be saved, and no failed/expired session may be recreated.

## Updated validation and final contract review

| Check | Main baseline | Updated |
| --- | --- | --- |
| API unit suite | 29 suites / 308 tests pass | 29 suites / 308 tests pass |
| Existing HTTP suite | 6 suites / 53 tests pass | 6 suites / 64 tests pass, including the nine added compatibility cases and two budgets |
| Identical final session compatibility cases | 19 pass, two budgets excluded | All 21 session lifecycle cases pass, including both budgets |
| Poll without authorization refresh | Two UPDATEs, including full JSON | One expiry-only UPDATE |
| Poll with authorization refresh | Three UPDATEs, including two full JSON saves | One full-session UPDATE |
| API/web production builds and web tests | Pass; all three web test files pass | Pass; all three web test files pass |
| Test-inclusive TypeScript checking | Four fixture diagnostics | The same four diagnostics, with identical output |
| Lint for affected code | Existing store promise-signature and legacy HTTP-fixture findings | No findings on added lines; existing findings retained |

The budget cases use a five-second delay between controller completion and
response finalization. They verify one UPDATE, the intended SQL column set, and
agreement between the stored, returned and cookie deadlines (cookie precision is
one second). Other cases cover temporary failures/retry, missing or expired rows,
revocation between read and write, concurrent later expiry, subsequent polls with
stale JSON cookie expiry, and data mutations after controller completion.

Implementation and safeguard review:

- Only `AmppSessionController.current` opts into deferred guard persistence.
  Authorization refresh logic and its ten-second interval are unchanged.
- The controller waits for a conditional UPDATE before returning its existing
  response fields and headers. Refreshed authorization is saved once; a plain
  renewal uses the existing expiry-only store operation.
- Successful completion is held in a WeakMap keyed by this request's Session
  object and checked against its session ID. Only the next duplicate touch is
  skipped, and it restores the confirmed deadline for cookie serialization.
  Another request/tab has a different object and still persists its own renewal.
- A later full save invalidates the completion marker and always executes SQL.
  Actual session data changes after the controller remain eligible for the
  middleware's ordinary full save; these may legitimately add another UPDATE.
- Failed writes never install a completion marker. The SQL predicates, affected
  row checks, `GREATEST`, rejection/cookie-clearing path, explicit-login-only
  creation and periodic cleanup remain in place.
- No schema, Admin, SPA, token, mailbox, AMPP transport, polling-frequency or
  general expiry-throttling changes are included. All existing comments and
  unrelated source behavior are retained.

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

For a baseline comparison, copy the final `session-expiry.e2e-spec.ts` into a
checkout of the base commit. Run its compatibility cases with
`--testPathPatterns=session-expiry --testNamePattern='^(?!.*current-session write budget)'`.
Run the two budgets separately with
`--testPathPatterns=session-expiry --testNamePattern='current-session write budget'`;
they are expected to fail there with two and three UPDATEs respectively.

Live MySQL multi-process/load, binlog/replication behavior and production AMPP
acceptance remain unverified. The guarantee under test is the UPDATE statement
count for ordinary successful polls, not a particular reduction in binlog bytes.
There remains a normal revocation race after the final confirmed write: a session
deleted after that point is rejected on its next request. Passing these checks
provides regression evidence, not a guarantee of no other regressions.
