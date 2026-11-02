# GVUI mailbox ownership and failed polling

## Behavior

The proxy previously treated `mailboxTTL: 1500000` as an absolute lifetime for
its session-owned alias. At 25 minutes it rejected notification polls locally
with 403, before AMPP could answer. The supplied October 30–November 2 logs show
approximately 40.6 million rejected notification polls for two aliases.

Mailbox ownership now lasts for the authorized application session. Every use
still checks layout/component access and the session's alias-to-upstream mapping.
Creating another mailbox no longer discards an existing tab's alias by age.
Revoked-layout mappings are still pruned, authorization refresh still clears
mailbox ownership, and the existing 512-entry session limit remains in place.
There is no new session JSON write on each poll.

This change leaves upstream expiration and its response to AMPP. The repository's
`GVMailbox` sample creates a two-minute mailbox and polls indefinitely, supporting
the distinction between mailbox settings and proxy ownership. Neither that sample
nor the captured logs establish the deployed AMPP server's precise TTL semantics.
The fix does not depend on assuming an inactivity TTL or on an undocumented renewal
endpoint. Upstream status codes and notification bodies are passed through.

An injected script protects asynchronous notification GETs in GVUI layout
documents, after URL rewriting, for both fetch and XMLHttpRequest:

- Successful responses reset failure backoff without consuming the response body.
- Other failures use exponential backoff with jitter, capped at 30 seconds.
- HTTP 401/403/404/410, or six consecutive failures, stop subsequent requests to
  that mailbox and show a notice to reopen the layout.
- The response that triggers suspension still reaches the GVUI client. A fresh
  mailbox alias remains usable if the client recreates it.
- A suspended fetch or queued XHR remains pending until cancellation/reopening;
  no synthetic success or immediate repeated rejection is returned to the retry loop.
- State is shared across query variants and transports for the same mailbox.
  Other mailboxes, API calls, origins and standalone workload frames are unaffected.
- Synchronous XHR retains its native synchronous contract and is not delayed.

## Validation and rollout

Regression tests execute the emitted browser JavaScript, including the complete
URL-rewriting bootstrap, using fake clocks and transport/DOM harnesses. They cover
repeated TTL boundaries (including a three-day-old alias), independent tabs,
authorization revocation, the mailbox limit, response preservation, terminal and
transient failures, cross-transport pacing, cancellation and XHR reuse.

Validation completed: API and web production builds, 292 API unit tests,
42 isolated HTTP tests (`PLATFORM_URL=https://ampp.invalid`), all three web test
suites, and ESLint for the GVUI service/helper and their tests. The response
rewriter retains its 41 existing Prettier findings, verified against the base
revision; this change adds no findings. A real headless Chromium smoke test with
a local HTTP server passed 11 assertions: denied fetch/XHR mailboxes each made
one request, suspended retries remained cancellable, a healthy mailbox worked,
transient recovery was paced, and the recovery notice was visible.

Rebuild/restart the API and reload existing GVUI tabs to install the browser guard.
The server-side ownership change applies to existing session mappings. No Admin,
schema, dependency, MySQL-session or MiniMixer OAuth changes are included.

Live AMPP acceptance remains necessary: keep two layouts open beyond several
25-minute boundaries, verify notification delivery after layout changes, revoke
one layout and check isolation, then interrupt/recover AMPP connectivity. Confirm
bounded poll traffic and the reopen notice for a genuinely expired/denied mailbox.
If native GVUI does not recreate a mailbox after actual upstream expiry, reopening
the layout is the explicit recovery path; automatic subscription replay is not
implemented or claimed by this change.
