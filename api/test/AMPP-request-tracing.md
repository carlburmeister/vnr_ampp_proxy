# Temporary AMPP request tracing

## Pre-change review

Baseline: PR 7 corrected commit `a9e4944`. Before production edits, the unchanged
baseline passed all 296 API unit tests and 51 isolated HTTP tests. Those suites
cover authorization/revocation, same-ID mailbox recreation, failures beyond six
retries, immediate successful/404 responses, retry cancellation, session merging,
and ordinary workload behavior. Run these same suites after adding tracing.

The affected paths are the SPA Proxy bootstrap, session guard, proxy controllers,
AMPP HTTP transport, mailbox mapping, failed-poll pacing, and WebSocket lifecycle.
Tracing must preserve response data/status, exceptions, callback receivers and
arguments, cancellation, retry timing, session-store operations, and authorization.
It must add no recovery logic, database operations, timers, dependencies, or schema
changes. Admin does not interpret the trace records or require changes.

Existing logs show upstream completions but cannot distinguish a browser that
stopped polling from local rejection or a pending request. No diagnosis of the
initiating failure is assumed. Live AMPP/browser reproduction and MySQL deadlock
causality remain unverified.

## Enable and capture

Set this in the API environment (for local development, `api/.env`):

```dotenv
AMPP_PROXY_TRACE=true
```

Rebuild the API for production, and restart it to load the environment setting.
The flag defaults to off and is independent of `AMPP_PROXY_SESSION_DEBUG` and
`AMPP_PROXY_BROWSER_DIAGNOSTICS`. No frontend rebuild, injected browser script,
Admin change, dependency installation, or database migration is required.

Records are one JSON object per line on stdout, prefixed `[AMPP proxy trace]`.
The existing dev-server log capture can collect them. Retain logs from startup
through failure, attempted reconnects, and the successful page refresh. Capture
the browser Network HAR and Console alongside them, with Preserve log enabled.
Record the times of those actions and any sleep/network/background-tab changes.

Only `/api/ampp-proxy/` HTTP requests and the existing proxy WebSocket upgrade
route start trace contexts. Standalone application/auth routes are unaffected.
The request middleware runs before body parsing/session loading, so malformed
requests, session-store errors and local authorization failures remain visible.

Every HTTP trace has an `X-Ampp-Trace-Id` response header visible in DevTools.
It is generated locally; incoming headers cannot choose a trace ID. All stages
include that `traceId`, UTC timestamp, PID, elapsed milliseconds, method,
sanitized path, proxy context, and a session fingerprint when known. WebSocket
trace IDs are recorded in the server log, correlated by context and time; no
WebSocket handshake/header behavior is changed.

## Events and interpretation

| Event | Meaning |
| --- | --- |
| `request.received` | The HTTP request entered the API before session loading |
| `authorization.start/end/error` | Guard entry, successful authorization, or rejection/failure |
| `authorization.refresh.start/end/error` | Permission refresh inside the guard |
| `policy.start/end/error`, `policy.recheck.*` | Proxy endpoint/layout/mailbox authorization |
| `session.get/set/touch.start/end/error` | Original store operation and callback result/duration |
| `session.merge.start/end/error` | Session merging, including waiting for the existing save queue |
| `proxy.api.*`, `proxy.ui.*` | Whole proxy operation, including token/cookie acquisition |
| `ampp.http.start/end/error` | Actual AMPP HTTP request, status/error and duration, per redirect/attempt |
| `mailbox.request/response` | Create, poll, subscribe/unsubscribe or delete; alias/upstream/topic fingerprints and response status |
| `poll.delay.start/end/error` | Existing failed-poll pacing, triggering status, selected delay and actual elapsed duration |
| `response.finish` | Node finished writing its response; not proof the browser consumed it |
| `response.close` | Response closed; `premature: true` means it did not finish writing |
| `request.aborted` | Incoming request was aborted |
| `websocket.upgrade.received` | A recognized proxy WebSocket upgrade began |
| `websocket.connect.start/end/rejected` | Upstream connection setup, open or rejected status |
| `websocket.close` | Browser/upstream closure, transport error, or a proxy decision to close |

A phase's `.start` with no matching `.end`/`.error` locates a pending operation
or a process that stopped. Use the PID and surrounding records to distinguish
process restarts. `response.close` during `poll.delay` explains early cancellation;
the existing timer/listener cancellation behavior is unchanged. A policy error
without `proxy.api.start` identifies a local rejection. An `ampp.http.end` followed
by a pending `session.merge` or store operation locates a post-AMPP stall.

Mailbox/session identifiers use stable SHA-256 fingerprints, not raw values.
`aliasId` identifies the client mailbox and `upstreamId` its mapped AMPP mailbox;
ordinary wrapper mailboxes have equal fingerprints. Topic fingerprints distinguish
new reconnect attempts without exposing notification contents.

For WebSockets, `side` identifies the observed event or proxy close decision.
`initiator` is the first observed side, not proof of the remote/network root cause.
Proxy decisions are logged before invoking the original close/terminate operation.
Known proxy close reasons remain readable; arbitrary remote reasons are represented
by `reason: other`, byte length and a fingerprint. No message frames are logged.

Query strings, OAuth fragments, arbitrary path segments, request/response headers,
cookies, bodies, SQL, error messages and notification contents are omitted.
Error classification retains only status, error type and code such as
`ER_LOCK_DEADLOCK` or `ECONNRESET`. This applies to these new trace records; existing
logging and the browser HAR have their own redaction behavior. Sanitize captures
before sharing, particularly tokens/cookies and mailbox secrets.

## Disable or remove

Set `AMPP_PROXY_TRACE=false` (or remove it) and restart the API to disable tracing.
When disabled, no trace contexts, response headers, listeners or store wrappers
are installed; stage helpers call the original operation directly. Tracing adds
no polling, watchdogs, database operations or retry timers in either mode.

All diagnostic changes are in one dedicated commit. Revert that commit (or the
corresponding squash commit) for complete removal. It is based on PR 7's corrected
branch so the diagnostics can be removed independently of the mailbox fix.

For manual removal, the implementation is isolated in
`src/ampp-proxy/diagnostics/`. Remove that directory and the imports/hooks marked
`TEMP AMPP trace` in:

- `src/main.ts`: middleware registration and store instrumentation.
- `src/auth/session-auth.guard.ts`: unwrap the guard/refresh spans and inline
  the private authorization helper back into `canActivate`.
- `src/ampp-proxy/ampp-api-proxy.controller.ts` and `ampp-proxy.controller.ts`:
  unwrap `tracePhase` calls, preserving their original operations.
- `src/ampp-proxy/ampp-cookie-http.service.ts`: unwrap the AMPP HTTP span.
- `src/ampp-proxy/ampp-proxy.service.ts`: remove the two mailbox trace calls.
- `src/ampp-proxy/gvui/gvui-poll-retry.ts`: unwrap the existing delay promise.
- `src/ampp-proxy/ampp-websocket-proxy.service.ts`: unwrap `traceUpgrade`, remove
  event/close hooks, and remove the relay diagnostic callback/parameter/calls.
- Remove the diagnostic flag in `.env.example`, this guide, and trace-specific
  additions to `test/gvui-polling.e2e-spec.ts` and the WebSocket bearer test.

`rg 'ampp-proxy-trace|TEMP AMPP trace|tracePhase|traceSocketClose|traceRelayFailure|traceFailure' src test`
helps verify removal. No stored session data or schema cleanup is necessary.

## Validation and remaining limits

The unchanged baseline passed 296 API unit tests and 51 HTTP tests before edits.
The updated checks cover tracing off/on, concurrent correlation, early closure,
policy rejection, original callback/return/error identity, mailbox mapping,
WebSocket closure, credential omission and an unavailable logging sink.
The existing HTTP recovery suite runs with tracing enabled to check same-ID
recreation, local/upstream failures, cancellation and ordinary workload behavior.

```sh
npm run build
npm test -- --runInBand
PLATFORM_URL=https://ampp.invalid npm run test:e2e -- --runInBand
AMPP_PROXY_TRACE=true PLATFORM_URL=https://ampp.invalid npm run test:e2e -- --runInBand
```

Final validation: API production build passes; 308 unit tests pass; all 53 HTTP
tests pass with tracing disabled and enabled. The diagnostic module and its
tests pass ESLint. Modified legacy files retain existing lint findings (73 errors
and one warning versus 76 errors and one warning on the same baseline files);
the cookie-header type finding is an existing line moved inside the HTTP span.
Test-inclusive TypeScript checking has exactly the same four baseline fixture
diagnostics in `mysql-session.store.spec.ts` and `client-permissions.service.spec.ts`.

Checks use controlled AMPP transports and
stores, not live AMPP or MySQL. Logging volume and serialization add overhead when
enabled and can affect race timing; retain/rotate stdout appropriately. There is
no sampling, added timeout, recovery behavior, or persistent trace buffer. A
successful diagnostic run does not establish that the original failure is fixed.
