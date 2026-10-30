# Server-side AMPP bearer selection

GVUI renews a platform-only OAuth token, while native workload wrappers also
request cluster access. Previously, every callback replaced the single
`session.amppAccessToken`. A later GVUI renewal could therefore make workload
state requests use a token without cluster scope, even with an unexpired login.

Tokens captured from the server's AMPP connection now live in
`session.amppAccessTokens`, keyed by OAuth client ID, with granted scopes,
issuance time and expiry. A callback must match its requested client. The newer
token wins within a client; independent clients remain separate. Browser
Authorization headers are not a source of server credentials.

Before an authorized request is forwarded, the selector requires:

| API                                                       | Scope      |
| --------------------------------------------------------- | ---------- |
| `/cluster/{state,control,matrix,fabric,snapshot}/api/...` | `cluster`  |
| Other supported APIs, including `/cluster/store/...`      | `platform` |

GET/HEAD also accept the corresponding `.readonly` scope; writes require the full
scope. The notification WebSocket uses platform write capability because it can
send messages. Tokens within 60 seconds of expiry are excluded. Among adequate
tokens, fewer granted scopes are preferred, then newer issuance/expiry. If none
is suitable, the existing API-key authentication path is used. This selection
does not grant access: the existing workload, dashboard, GVUI and resource
policies still run first. Genuine AMPP 403 responses are returned unchanged.
The existing HTTP 401 recovery contract is preserved; invalidation removes only
the rejected token instead of discarding every OAuth client's token.

The existing session save queue merges concurrent HTTP token updates by client
and issuance/expiry.
An invalidation cannot delete a concurrently renewed replacement. Utility-login
resets and client changes clear all tokens and change a generation marker so
responses started before the reset cannot restore old credentials. Logout still
destroys the entire session. Valid legacy single-token sessions migrate lazily;
malformed, missing-scope or expired tokens use the existing authentication
fallback. A legacy token cannot overwrite a newer cached token for its client.

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

For live acceptance, repeat GVUI launches and exercise controls, dashboards and
standalone workloads. Leave the layout open through wrapper and GVUI renewals
(and an overnight session), then verify workload-state reads still succeed,
controls and notification connections work, and SRT Input #2 stays excluded.
Check logout and client changes. Keep credentials out of shared diagnostics.
