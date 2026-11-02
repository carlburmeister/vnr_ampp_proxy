# GVUI mailbox ownership and failed polling

## Behavior

The proxy previously treated `mailboxTTL: 1500000` as an absolute lifetime for
its session-owned alias. After 25 minutes it rejected notification polls locally
with 403, before AMPP could answer. Ownership now depends on the authorized
session, layout and alias mapping. Actual AMPP mailbox expiration and recovery
responses continue to reach the upstream client; the captured SDK recreates the
same mailbox ID after a 404. No undocumented AMPP renewal endpoint is assumed.

The initial PR's browser polling interceptor has been removed. Native fetch and
XHR send, timeout, cancellation and event behavior remain intact. The API instead
delays only failed GVUI notification GET responses with status 403 or 5xx:

- Exponential backoff with jitter starts around one second and caps at five
  seconds. There is no permanent suspension or failure-count cutoff.
- Success, 401, 404 and 410 return immediately and clear failure state. Successful
  validated mailbox creation also resets state for that alias.
- Failure status, body and headers are preserved. Client disconnect releases the
  delay timer and listener. Other workload requests are unaffected.
- State is isolated by session, layout and alias, shared across query variants,
  capped at 4,096 entries and expired lazily after ten minutes of inactivity.
  It is local to each API process, not a distributed rate limiter. It paces
  sequential poll loops; it does not limit arbitrary parallel clients.

## Cleanup and concurrency

Aliases record `lastUsedAt` in session JSON, updated at most once per minute per
active alias. Activity is saved before starting the upstream request. Session
merging keeps timestamps monotonic and prevents stale cleanup or activity from
deleting renewed entries or resurrecting removed/recreated aliases. Current
authorization is checked again after the activity save reloads permissions.

At the 512-entry limit, aliases with recorded inactivity of at least 26 minutes
(25 minutes plus the recording margin) can be reclaimed. Creation age alone
cannot evict an active tab. Below capacity, quiet authorized aliases remain.
Revoked-layout aliases are pruned, and authorization refresh still clears
ownership. Capacity is checked before upstream creation and after merging with
the latest stored session. A rejected merge restores the latest session values
so automatic saving of an error response cannot persist an oversized candidate.

Legacy aliases without activity timestamps receive one observation window.
A completely full legacy session can still return 409 during that window;
the initialized timestamps are persisted even when creation is rejected. After
26 minutes, unused aliases can be reclaimed while polled aliases remain. This
avoids guessing that an old but active legacy tab is idle.

## Validation and rollout

See [GVUI-regression-review.md](GVUI-regression-review.md) for the pre-change
evidence, baseline comparisons, checks and remaining risks. Repeatable checks:

```sh
cd api
npm run build
npm test -- --runInBand
PLATFORM_URL=https://ampp.invalid npm run test:e2e -- --runInBand
node test/gvui-browser-compat.cjs
```

The browser comparison requires Chromium and permission to bind local sockets.
It uses the complete rewriting bootstrap and the real API controller against a
local test transport. HTTP tests separately exercise the real guard, policy and
session merging. No live AMPP credentials or MySQL are required for these tests.

Rebuild/restart the API. Reload any GVUI tabs that loaded the initial PR's browser
interceptor so they discard that JavaScript. No Admin, SQL schema, dependency,
MySQL deadlock-handling or Flow Monitor changes are included. Activity tracking
adds bounded session writes; database load still needs observation in deployment.

Live AMPP acceptance remains pending: keep multiple layouts open across repeated
25-minute boundaries, verify notification delivery and same-ID recreation, revoke
one layout and check isolation, then interrupt and restore AMPP connectivity.
Check polling rate and session-store load. Exact deployed AMPP TTL semantics,
multi-process concurrency and long-session resource use remain operational checks.
