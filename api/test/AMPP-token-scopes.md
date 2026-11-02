# Server-side AMPP bearer selection

GVUI renews a platform-only OAuth token, while native workload wrappers also
request cluster access. Previously, every callback replaced the single
`session.amppAccessToken`. A later GVUI renewal could therefore make workload
state requests use a token without cluster scope, even with an unexpired login.

Tokens captured from the server's AMPP connection now live in
`session.amppAccessTokens`, keyed by the JSON representation of
`[clientId, sortedUniqueScopes]`, with client ID, granted scopes, issuance time
and expiry. A callback must match its requested client. The newer token wins
within a client and scope set; distinct scope sets remain separate even when
wrappers and dashboards share an OAuth client. Browser Authorization headers
are not a source of server credentials.

Before an authorized request is forwarded, the selector requires:

| API                                                                                                                    | Scope      |
| ---------------------------------------------------------------------------------------------------------------------- | ---------- |
| `/cluster/{state,control,matrix,fabric,snapshot}/api/...`                                                              | `cluster`  |
| `/mocha/application/<workloadId>/api/...`                                                                              | `cluster`  |
| `/identity`, `/configuration`, `/discovery`, `/logging`, `/notifications`, `/hubmanager`, `/ampp/control` API families | `platform` |
| `/cluster/store/api/...`, `/api/v1/store/...`, `/pushnotificationshub`                                                 | `platform` |

Mocha application APIs include state, health, configuration, counters and control
requests used by native workload UIs. Treating these as platform-only previously
selected GVUI's narrower token and caused partial rendering. API families without
an explicit classification use the existing server authentication fallback;
the selector does not assume platform scope for an unknown service.

GET/HEAD also accept the corresponding `.readonly` scope; writes require the full
scope. The notification WebSocket uses platform write capability because it can
send messages. Tokens within 60 seconds of expiry are excluded. Among adequate
tokens, fewer granted scopes are preferred, then newer issuance/expiry. If none
is suitable, the existing API-key authentication path is used. This selection
does not grant access: the existing workload, dashboard, GVUI and resource
policies still run first. Genuine AMPP 403 responses are returned unchanged.
The existing HTTP 401 recovery contract is preserved; invalidation removes only
the rejected token instead of discarding every OAuth client's token.

The existing session save queue merges concurrent HTTP token updates by client,
scope set and issuance/expiry. An invalidation cannot delete a concurrently
renewed replacement. Utility-login
resets and client changes clear all tokens and change a generation marker so
responses started before the reset cannot restore old credentials. Logout still
destroys the entire session. Valid legacy single-token and client-only-cache
sessions migrate lazily, including persistence snapshots used during concurrent
invalidation. Malformed, missing-scope or expired tokens use the existing
authentication fallback. A legacy token cannot overwrite a newer cached token
for the same client and scope set.

Only the SPA proxy API changes. Session JSON uses the existing `user_sessions`
LONGTEXT column; no Admin, Web, schema, dependency or environment changes are
needed. Rebuild/restart all API processes together. The redirect isolation and
optional diagnostics remain independent. The upstream wrapper-document 404s
captured during the overnight reload remain a separate issue.

## Validation

Automated tests cover both renewal orders, all four captured workloads, actual
upstream Authorization construction, read/write scopes, expiry, legacy sessions,
fallback/401/403 behavior, concurrent renewals, reset/client-change invalidation,
and SRT Input #2 denial through the real HTTP controller and policy. An isolated
regression fails on the previous code when wrapper renewal precedes GVUI renewal.
All upstream responses in these tests are fixtures; no live AMPP is contacted.

The regression fixtures include all ten distinct application API URLs that
returned 403 in the supplied captures, including the standalone Output capture.
The simulated upstream rejects a bearer without cluster access. All twenty
application/order cases and two same-client scope-variant cases failed on the
previous branch revision before correction. A ten-hour simulated renewal test
interleaves GVUI and wrapper callbacks while exercising application requests.
HTTP tests apply the real guard, controller and policy to those application APIs
and retain the denied SRT Input #2 checks. These checks verify scope selection,
not the correctness of live controls, preview media, or upstream OAuth services.

For live acceptance, repeat GVUI launches and exercise controls, dashboards and
standalone workloads. Leave the layout open through wrapper and GVUI renewals
(and an overnight session), then verify workload-state reads still succeed,
controls and notification connections work, and SRT Input #2 stays excluded.
Check logout and client changes. Keep credentials out of shared diagnostics.
