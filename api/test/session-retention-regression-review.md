# Retained session audit records

## Scope and baseline evidence

Approved scope: keep all `user_sessions` rows after logout, expiry, revocation
and replacement, while rejecting the ended session for authentication. PR #13
already records IP/start/contact/activity. The supplied ALTER adds nullable
`ended_at`, `end_reason`, and the cleanup/audit indexes. Only the SPA Proxy
repository changes. The Admin runtime currently does not query this table;
its historical schema dumps were checked and are left intact.

| Behavior | Existing evidence | Required change |
| --- | --- | --- |
| Successful credentials regenerate the ID; failed login preserves it | Auth controller and session HTTP suites | End the previous session as replaced only after successful authentication |
| Logout clears the cookie, expiry/revocation rejects reuse | Store and HTTP lifecycle suites | Retain and end the row; preserve cookie handling |
| Late data saves/renewals/metadata cannot resurrect a session | Store, expiry and renewal tests | Require unfinished, unexpired rows for reads and all writes |
| Concurrent renewal never shortens a live deadline | Renewal HTTP cases | Leave renewal SQL intact except for the unfinished-row predicate |
| Startup/minute cleanup is bounded, non-overlapping and retryable | Store timer tests | Finalize at most 1000 unfinished expired rows per pass |
| Temporary DB/authorization failures recover without revocation | HTTP session suites | Preserve existing exception classification |
| Proxy/session ownership and streaming behavior are preserved | HTTP proxy, GV.UI, recorder and socket suites | Keep their contracts and rely on the store to reject ended rows |

Baseline is PR #13 at aea386c, measured before production changes: 343 API unit
tests passed; 156 HTTP/e2e tests passed with the same pre-existing generic app
fixture failure (PLATFORM_URL unset, followed by cleanup of an uninitialized
app); all 30 web tests passed.

## Implementation decisions

- First successful termination wins, including its reason, timestamp and audit
  payload. Repeated destroy/logout and later cleanup do not rewrite history.
- Explicit termination uses min(current expiry, server time). Already expired
  rows retain their original deadline and the expired reason, even if logout
  or login replacement is observed later. Truncate expires_at to that ending
  time and also require ended_at IS NULL on active operations.
- Keep existing request-session destruction/cookie clearing. The explicit logout
  and successful-login paths set their reason before the generic destroy hook;
  generic invalidation defaults to revoked. Missing rows remain idempotent.
- Capture an immutable, whitelisted identity snapshot at login in data.audit:
  userId, username, displayName, clientId, userType. Current credential queries
  use the client name as displayName, so its login-time label is preserved too.
  No additional database identity lookup or schema columns are needed.
- End records atomically using the latest database JSON, retaining only these
  audit fields and the dedicated IP/timestamp columns. Existing sessions without
  a snapshot fall back to their stored user identity; unknown values stay null.
  Invalid JSON must not prevent expired-row cleanup. Tokens, cookie jars,
  permissions and other live session state are removed from ended JSON.
- No retention purge is added. Unfinished-row cleanup uses the new composite
  index, avoiding repeated scans of accumulated audit history. This records
  validity intervals, not a historical stream of browser interactions.

## Validation and rollout

| Check | Baseline aea386c | Updated |
| --- | --- | --- |
| API unit tests | 343 passed | 348 passed |
| HTTP/e2e tests | 156 passed, 1 existing app fixture failure | 164 passed, same failure |
| Web lifecycle/unit tests | 30 passed | 30 passed |

Both API and web production builds pass. Real MySQL **8.0.46** checks pass for
new-table bootstrap, applying the exact additive migration to existing live
data, first-end idempotency, all four ending reasons, immutable login identity,
credential removal, concurrent late saves, unknown legacy metadata, corrupt JSON
and the 1000-row cleanup bound. Restarting cleanup finishes the remaining row
without deleting any of the 1003 test rows.

Production-build and Vite-development Chromium checks pass for idle polling,
trusted input, logout cleanup and proxied/embedded pages. One Vite run timed out
waiting for input reporting after advancing the virtual clock. The fixture now
focuses the page and waits for session polls and protected UI to settle before
issuing input; the existing activity-response assertions remain in place and
the rerun passes. No browser/application source changes were needed.

The new HTTP fixture helper passes ESLint. API changed lines have no new lint
findings; existing whole-file lint findings are left intact (including the
existing type-formatting finding in session-data.ts). Browser/MySQL scripts pass
syntax checks and the diff passes whitespace checks. Diff review confirms no
production DELETE remains for user_sessions, all active reads/writes require an
unfinished, unexpired row, existing comments remain, and cookie/response,
authorization, throttling, timeout, concurrency, cleanup limits and socket
contracts are preserved. Historical row retention and sanitized ended JSON are
the intentional storage-contract changes.

Live AMPP and the user's database/proxy deployment were not exercised. The
same generic app fixture still fails without PLATFORM_URL, as on baseline.

Apply the supplied additive migration before this version of the API. It is
checked in under api/migrations; do not rerun it if already applied manually.
CREATE TABLE IF NOT EXISTS provisions new installations only. No shared/live
database was modified by the development checks.

Deploy to every API instance before relying on retained history. Older API
instances still physically delete expired rows, including rows ended by a new
instance, so retention is not guaranteed during a mixed-version rollout.
