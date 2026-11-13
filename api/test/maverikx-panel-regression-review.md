# MaverikX Panel proxy compatibility review

## Evidence and scope recorded before production edits

- Baseline: `9784bbd` on `main`. The supplied HAR's Panel tab calls
  `GET /ampp/control/api/v1/panel/panels` and receives the proxy's endpoint-policy
  403. The captured SDK expects a `panels` dictionary and the UI selects entries
  with `applicationType === "MaverikX"` before constructing
  `/ampp/control/embedded/panelControl/{panelId}/workload/{workloadId}`.
- The same capture rejects macro/application-reference/unscoped-workload reads
  and the workload's image-library prefix. Workload-specific Mocha calls work.
- Existing authorization resolves individually assigned `is_parent=0` workloads
  and authorized children of parent assignments. Admin assignments, database
  contracts, deny rules, and read-only resource visibility must remain intact.
- Existing dashboard workload/macro response filters can be reused; the panel
  catalogue needs its own compatible filter. Dashboard command authorization
  must retain its dashboard/reconciliation-key checks.
- Session-derived panel IDs must survive concurrent requests for different
  workloads without restoring data after authorization refresh or logout.
- HTTP transport, credential selection, retry, recorder cancellation/cleanup,
  WebSocket queues and timeouts are outside the change and retain their existing
  compatibility suites.

## Baseline validation

- API unit suite: 29 suites, 348 tests passed.
- API build: passed.
- Full HTTP suite: 8 suites / 164 tests passed; existing `app.e2e-spec.ts` fails
  because `PLATFORM_URL` is unset (its cleanup also calls `close` on an app that
  was never created). This environment has no configured AMPP/DB credentials.

## Assumptions and unknowns

- There is no successful panel catalogue, panel-definition response or loaded
  panel iframe in the supplied HAR. Fixture data will preserve the captured
  SDK's catalogue contract; unknown definition shapes must fail closed.
- The repository SDK documents `/control/commit`, serialized form data, and
  `gv.ampp.control.{workload}.{command}` notifications. Runtime support must
  bind these to an authorized MaverikX context, never resource-only workloads.
- A real AMPP smoke test remains necessary to confirm the installed panel's
  definition shape, exact command/schema dependencies and live state updates.
  Local browser and HTTP fixtures establish proxy behavior, not AMPP behavior.

## Updated validation and diff review

| Check | Baseline | Updated |
| --- | --- | --- |
| API unit suite | 29 suites / 348 tests passed | 30 suites / 366 tests passed |
| API build | Passed | Passed |
| Full HTTP suite | 164 passed; 1 configuration-dependent smoke test failed | 167 passed; same smoke test failed |
| Defect reproduction tests before production edits | 10 failed / 1 passed | All pass, with additional command/notification checks |
| Chromium workload-to-panel flow | Not available on baseline | Passed with local upstream fixtures |

The full HTTP command still exits nonzero because `app.e2e-spec.ts` requires
unconfigured `PLATFORM_URL`/service settings. No new HTTP suite failures were
introduced. New TypeScript files pass ESLint. Existing touched files have lint
debt on the baseline; only newly added lines were corrected, avoiding unrelated
formatting changes. The browser script passes `node --check` and the diff passes
`git diff --check`.

### Affected behavior and evidence

- `ampp-maverikx-panel.service.spec.ts` covers the captured read endpoints,
  individual and parent-child assignment contexts, incompatible panels,
  serialized unauthorized references, malformed catalogues, definition
  revalidation, encoded/altered iframe targets and allowed retry timestamps.
- Existing dashboard workload/macro filters remain in place. Application
  references retain their established dashboard-scope behavior; newly permitted
  standalone MaverikX contexts receive only the MaverikX reference. Existing
  dashboard commit and reconciliation-key requirements remain independent.
- New panel commands require the active authorized MaverikX workload, a
  supported application envelope, and valid serialized object form data.
  Resource-only workload IDs and nested unauthorized workload references are
  rejected. No panel editing, deletion, global wildcard control subscriptions,
  or blanket AMPP Control namespace permissions were added.
- `maverikx-panel.e2e-spec.ts` exercises real guards/controllers/proxy/filters
  and persistence. It checks that policy rejections never reach the fixture
  upstream and that resource-only state retains its existing limited fields.
- Session tests cover independent workload tabs, concurrent catalogue removal,
  and permission refresh during an upstream request. AuthService's assignment
  refresh test confirms derived panel IDs are cleared. Existing logout/session,
  token, Matrix, dashboard, recorder-routing and GV.UI suites still pass.
- `node test/maverikx-panel-browser.cjs` uses real Chromium with the same HTTP
  pipeline to verify catalogue selection, dynamically rewritten iframe loading,
  panel-definition access, get-state/command requests, a scoped subscription,
  an HTTP state update after Cut, and a 403 for a resource-only iframe target.
  It does not establish live AMPP or live WebSocket panel behavior.

### Contracts, lifecycle and remaining risks

- Only the SPA Proxy API repository changes. Admin assignment handling and the
  database schema were inspected; no migration or Admin change is needed.
- A new optional session-JSON field holds compatible panel IDs by workload.
  Existing sessions without that field learn it from the next catalogue read.
  Authorization refresh clears it; merge logic refuses revoked/deleted sessions
  and does not overwrite a concurrent catalogue replacement/removal.
- Panel pages now require a discovered compatible panel and an authorized
  workload binding. Arbitrary/unbound panel URLs are intentionally rejected.
- Transport retries, credential routing, buffering, timeout, cancellation and
  recorder cleanup code were not changed. Their compatibility tests retain the
  baseline behavior; this is evidence of the tested cases, not a guarantee of
  regression freedom.
- Live AMPP verification is outstanding: obtain a successful catalogue and
  panel-definition sample, open the Panel tab, select the installed panel,
  exercise state updates and a permitted control, and inspect any further
  schema/configuration/notification requests. Unknown response shapes or
  undocumented endpoint dependencies remain denied. Open the PR as a draft
  until that smoke test establishes the installed AMPP contract.
