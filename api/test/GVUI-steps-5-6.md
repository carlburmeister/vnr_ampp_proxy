# GVUI steps 5 and 6: authorized launch and SPA controls

These updates extend the step 4 SPA branch. Admin and database definitions are
unchanged; the installed `db_schema/gvui_20261023` schema and Admin step 3 lifecycle
cleanup remain prerequisites. `GVUI_PHASE2_ENABLED=true` enables the new flow;
its default remains false. Restart the API and rebuild/reload the web app after
updating. Disabling the flag restores the separately configured Phase 1 UI and
blocks Phase 2 contexts without deleting stored grants.

## Behavior

- Client administrators now have a **GVUI Layouts** section in User Management.
  Checkboxes use assignment row IDs, load existing grants and participate in
  dirty-state/save handling. Association hints explain missing workload access.
  Omitted fields from older clients still preserve grants. The editor uses DB
  resources, so an AMPP catalog outage does not block unrelated permission saves.
- The session/resource responses report `gvuiPhase2Enabled`. The home page uses
  effective layout grants from the existing session refresh flow, shows associated
  layouts beneath the authorized workload and unassociated layouts at top level,
  and replaces the Phase 1 button when Phase 2 is enabled. Names sort naturally
  within the layout group and participate in shared button sizing.
- `GET /api/ampp-proxy/gvui/:layoutId/launch` checks the authenticated session's
  effective UUID grant before contacting AMPP. It resolves transport from actual
  independently permitted native components, never an unrelated first workload.
  It returns a local `/api/ampp-proxy/ui/gvui-UUID/gvui/desktop/UUID` address.
  Layout contexts do not share mutable launch state; embedded application routes
  still use their independently authorized workload IDs. Multiple parents and
  standalone applications are supported. Missing/deleted/unsupported layouts and
  layouts without accessible components return an explicit unavailable error;
  catalog outages return 502 and preserve grants.
- The captured configuration endpoint returns only the context's granted layout.
  Filtering preserves metadata/geometry while removing denied native components.
  Origins, packages and exact callback routes are validated. External websites,
  embedded dashboards and other widgets remain blocked. Filtered catalog responses
  have no reusable upstream validators and use `Cache-Control: no-store`.
- Mailboxes have per-session/per-layout ownership, random upstream identities and
  bounded lifetime/state. HTTP polls and JSON/MessagePack hub frames filter GVUI
  notifications. Other layouts, ordinary workload contexts, unknown payloads and
  inappropriate subscriptions cannot use a layout's channel. Existing workload
  subscription requests retain their separate Matrix handling.
- Existing guarded requests/socket revalidation pick up permission changes.
  Each open layout also checks `/api/ampp-proxy/gvui/:layoutId/access` every ten
  seconds and on focus/pageshow. A denied or unverifiable result removes the
  document's embedded frames and asks the user to reopen the layout. Expired
  sessions are rejected by the existing session guard. Concurrent proxy cache
  writes merge independent mailbox records without restoring revoked access.

## Isolated checks

Run `npm run build` and `npm test -- --runInBand` in `api/`, then
`PLATFORM_URL=https://ampp.invalid npm run test:e2e -- --runInBand`. HTTP tests
need local socket permission. Run `npm run build` and `npm test` in `web/`.

Tests cover permission management, placement, independent launches, denied
components, catalog/cache handling, unsupported types, outages, session expiry,
revocation, emitted document checks, mailbox ownership and synthetic non-empty
HTTP/JSON/MessagePack notifications. Frontend tests execute real component hooks
and event handlers with a small isolated harness; they do not render a browser.

**Live notification acceptance is pending.** No non-empty local AMPP GVUI update
capture was available. Only complete identified configuration notifications are
supported by the new filter; unknown/delta payloads are dropped. Binary frames
requiring component removal are dropped rather than partially rewritten. These
tests do not establish compatibility with every AMPP notification variant. Obtain
a sanitized non-empty HTTP/WebSocket capture while changing a layout locally,
add a minimized regression fixture, and adjust only that documented event form
before enabling general users. Reloading a layout refetches its current catalog.

## Combined local UI acceptance (steps 4, 5 and 6)

Use disposable assignments/grants and record the original state for restoration.

1. As a same-client administrator, open **Actions → User Management**. Verify the
   section appears with the flag enabled and disappears when disabled. Grant an
   unassociated layout, save and confirm the checkbox persists after reopening.
   With the target user signed in separately, wait for the normal session refresh
   and confirm its top-level button appears without another login.
2. Launch it and verify the actual workload controls/media, OAuth callbacks and
   resizing. Open a second assigned layout in another tab, including layouts
   across authorized parents/standalone workloads. Each tab must keep its own
   layout; neither grant may add workload/dashboard permissions.
3. Associate a layout with a workload through Admin and verify nested placement.
   Deny one embedded application's UI and confirm authorized siblings remain.
   Deny the associated workload and verify the entire associated layout is hidden.
   Missing/deleted layouts, unsupported components and no accessible components
   must produce an explicit launch error, not a blank replacement tab.
4. Uncheck a layout, save, and confirm the home button disappears and an open
   layout is blocked after authorization refresh plus its next access check.
   Repeat with an Admin client restriction, assignment deletion/reassignment,
   logout, idle expiry and flag disable. Check other tabs and direct layout,
   callback, catalog and mailbox URLs for rejection. Verify ordinary workload and
   dashboard rendering, permissions, subscriptions, controls and media still work.
5. During an AMPP outage, verify a useful launch error and successful unrelated
   workload/dashboard permission saves without grant loss. Repeat with an older
   request body omitting `gvuiLayoutIds` and an explicit empty array.
6. Capture a real non-empty layout update and check both HTTP and WebSocket
   delivery between two users/layouts. Document supported events and verify that
   cross-client, cross-layout, denied-component and revoked-channel data is absent.

Record live MySQL locking, browser rendering, AMPP notifications, callbacks and
control/media results separately. Full test-inclusive TypeScript checking also
has four pre-existing fixture errors described in `GVUI-step-4.md`; the production
build excludes those fixtures.

Cloud validation: both production builds, 153 API unit tests, 26 isolated HTTP
tests and the frontend suites (including nine new GVUI checks) pass. Lint passes
for the new TypeScript files. The unchanged User Management effect also retains
its existing `react-hooks/set-state-in-effect` lint finding; no authentication
or rendering refactor was included to address that unrelated baseline issue.
