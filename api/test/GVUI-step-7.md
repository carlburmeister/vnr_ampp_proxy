# GVUI step 7: permanent implementation and dashboard components

## Deployment

The Admin step 3 lifecycle updates and verified `db_schema/gvui_20261023` schema
are prerequisites. This update requires no further Admin, schema or dependency
changes. GVUI permission queries run whenever authorization is built/refreshed;
missing tables and database failures fail the request. Verify the schema before
deploying, restart the API and rebuild/reload the web app.

No GVUI activation variables are required. Remove the former GVUI phase/test
settings from deployment environments: they have no effect. The designated-user
POC service, hardcoded layout/eligibility list, test button and launch endpoint
are deleted. Session/resource APIs no longer report an activation flag. Older
sessions rebuild authorization immediately on their next guarded request; rolling
outdated SPA tabs should be refreshed to use the new contracts. Database grants
are preserved, and older permission bodies omitting `gvuiLayoutIds` preserve them.

## Supported components and authorization

Native workload web frames retain exact origin/package checks and independent
workload permissions. Dashboard web frames now support the existing AMPP route
`/cluster/systemdashboard/dashboard/<UUID>` on the configured platform origin.
Both effective dashboard grants and the independent dashboard ID grant are
required. Custom SPA dashboard pages are not AMPP web components.

An associated dashboard requires effective access to its associated workload.
An unassociated dashboard uses an eligible native workload or an authorized
associated dashboard's workload from the same layout. An unassociated dashboard
alone does not select an unrelated first workload; a layout without an eligible
transport context returns an explicit unavailable error. Neither layout nor
dashboard grants manufacture workload access.

The filtered catalog resolves dashboard URLs to absolute local dashboard proxy
addresses using the authorized context. Dashboard frames reuse the existing
configuration, Matrix/resource filtering, controls, callbacks and session checks.
Denied dashboards are removed while authorized sibling components retain their
metadata, geometry and order. Unsupported widgets, external sites, credentials,
query/hash-bearing component URLs and unknown paths remain blocked.

There is no visual redesign or new CSS. Any future presentation fixes must be
justified by an identified issue and scoped to proxied GVUI layout documents.
Shared embedded-application styling and standalone pages are unchanged.

## Isolated validation

Run `npm run build` and `npm test -- --runInBand` in `api/`, then
`PLATFORM_URL=https://ampp.invalid npm run test:e2e -- --runInBand`. HTTP tests
require local socket permission. Run `npm run build` and `npm test` in `web/`.

Permanent regression coverage retains native sibling/metadata/cache, OAuth,
callback, launch, permission, expiry, mailbox, notification and revocation checks.
It adds dashboard permission/association, generated proxy URL, unsafe widget,
revocation and old-session upgrade cases. POC-only and activation-mode tests are
removed. Frontend tests execute real component hooks/handlers in an isolated
harness; browser rendering requires local acceptance.

Full test-inclusive TypeScript checking retains four pre-existing fixture errors
in the MySQL-session/client-permission tests. The unchanged User Management effect
retains its existing React `set-state-in-effect` lint finding. Production builds
exclude those legacy test fixtures.

Cloud validation passes both production builds, 152 API unit tests, 27 isolated
HTTP tests and all frontend suites (including eight GVUI component/contract
checks). Lint passes for the permanent GVUI feature files.

## Local acceptance

Use disposable assignments/grants and record their original state for restoration.

1. With no former GVUI settings, grant and clear layouts through User Management.
   Check immediate refresh of an existing session, associated/top-level home
   placement, two layouts in independent tabs, client restrictions and older saves
   omitting the GVUI field. Verify the old test endpoint is unavailable.
2. Test a native-only layout, an associated dashboard-only layout and a mixed
   layout spanning authorized parent/standalone contexts. Check dashboard rendering,
   configuration, Matrix/resource visibility and controls against standalone
   dashboard behavior. Verify an unassociated dashboard uses only a context from
   that layout and reports unavailable when none exists.
3. Revoke the dashboard, its association or one native workload. Authorized
   siblings must survive. Check layout revocation, assignment deletion/moves,
   client restrictions, cross-client/direct URLs, logout and idle expiry. Neither
   dashboard/layout grants may add workload controls or resource permissions.
4. Retest callbacks, controls, media/WebRTC and resizing in GVUI and existing
   standalone workloads/dashboards. During an AMPP outage, launch must show a useful
   error and unrelated permission saves must preserve grants.
5. Capture a sanitized non-empty local GVUI update event and validate two
   users/layouts over HTTP and WebSocket, including dashboard/component revocation.
   Add a minimized fixture before claiming support for the observed event form.

Live MySQL locking, AMPP browser/OAuth, control/media and non-empty notification
validation are pending in this environment. Only complete identified configuration
notifications are supported. Unknown/delta events and binary frames needing
component/URL rewriting are dropped; reload refetches the current filtered catalog.
These isolated tests do not establish compatibility with every AMPP widget or
notification variant.
