# GVUI step 4: database permissions and session contracts

This step changes the SPA proxy backend only. Phase 1 launch behavior and the
frontend navigation remain unchanged. General layout launch, catalog/component
filtering and notification isolation are step 5; user-management selectors and
home-page placement are step 6.

## Rollout

The shared database must first have the Admin repository's
`db_schema/gvui_20261023/update.sql` installed and verified with its `check.sql`.
Its three tables are `ampp_gvui_layouts`, `client_user_gvui_permissions` and
`client_gvui_denials`. This PR adds no schema or dependencies.

`GVUI_PHASE2_ENABLED` defaults to disabled unless its value is exactly `true`.
While disabled, no GVUI table reads or writes occur, legacy permission saves
continue to work, and the added response arrays are empty. Explicit GVUI grant
changes are rejected while disabled. Enabling the flag requires the installed
schema; database errors propagate rather than silently granting access.
Disabling it clears effective GVUI access at the next guarded request, preserves
stored grants and avoids further GVUI queries. It does not enable generalized
GVUI launching or make the existing Phase 1 test path a Phase 2 authorization path.

## API contracts

- `GET /api/user-management/resources` adds `gvuiLayouts`, each with `id` (the
  integer assignment row ID), `layoutId` (AMPP UUID), `name` and nullable
  `associatedWorkloadId`. Only same-client, non-restricted assignments are listed.
- `GET /api/user-management/users/:userId/permissions` adds `gvuiLayoutIds` using
  assignment row IDs, excluding client-restricted layouts and associations.
- `PUT` to that permission URL accepts optional `gvuiLayoutIds`. Omission
  preserves all existing GVUI grants, including currently hidden restricted
  grants. Explicit `[]` clears them; null, non-array values, invalid integer IDs
  and arrays larger than 500 are rejected. The existing workload/dashboard/child
  fields remain required. Saves are atomic across all permission categories.
- Client-admin role and target-client ownership are rechecked after acquiring
  the same client-row lock used by Admin. Supplied layouts are checked against
  the target user's client and client restrictions inside that transaction.
  Grant creator IDs reference the acting client user, as required by the schema.
- `GET /api/ampp/session/current` adds `allowedGvuiLayoutIds` (AMPP UUIDs) and
  `allowedGvuiLayouts` (`id`, `name`, `associatedWorkloadId`). Effective layouts
  require explicit same-client user grants, with client restrictions taking
  precedence. Associated layouts also require effective access to the associated
  workload, matching dashboard visibility. Layouts never add workload permissions
  or manufacture a proxy launch context.

GVUI identity, names, associations and flag state participate in authorization
fingerprints. Permissions refresh using `AUTH_PERMISSION_REFRESH_INTERVAL_MS`
(default 10000 ms) on guarded requests. Missing fields in older sessions and flag
changes force an immediate refresh. Proxy cache merges copy the newer GVUI
authorization snapshot instead of restoring stale access.

## Isolated checks

From `api/`:

```sh
npm run build
npm test -- --runInBand
npm run test:e2e -- --runInBand --testPathPatterns='gvui-permissions|session-expiry'
```

The complete HTTP suite also includes an application wiring smoke test. It needs
a syntactically valid `PLATFORM_URL`; `PLATFORM_URL=https://ampp.invalid npm run
test:e2e -- --runInBand` runs it without a real AMPP account. Local HTTP sockets
must be permitted by the execution environment.

The HTTP tests exercise DTO validation, real permission services and controllers
with an in-memory SQL adapter and an already authenticated session. They create
no MySQL schema/accounts and contact no AMPP service. The existing session tests
separately cover cookies, expiry and revocation. Builds/tests in `web/` check the
unchanged frontend for regressions. SQL semantics, MySQL locks and live AMPP
behavior still require local testing.

## Local acceptance

Use existing local accounts and disposable assignments/grants; record and restore
their original state. Do not import a full schema dump over the running database.

1. With the flag disabled, use the existing workload/dashboard management flow
   and confirm no GVUI table queries occur.
2. Verify the schema, enable the flag and use an existing client-admin session.
   List resources and round-trip grant/clear requests for a same-client user.
   Ordinary users and administrators from another client must be rejected.
3. Save a legacy body without `gvuiLayoutIds`; check that raw GVUI grants remain.
   Send `[]` to clear, and verify null/malformed values fail without modifying any
   permission category. A failed later workload write must also roll back GVUI.
4. Add a client restriction through Admin. Confirm it overrides an existing user
   grant and cannot be granted again through the permission API. Verify assignment
   deletion/moves and user reassignment do not expose another client's layouts.
5. Poll the current session before/after granting, revoking, renaming, moving or
   deleting an assignment. Changes must appear within the configured interval.
   Check old sessions without GVUI fields and flag disable/re-enable transitions.
6. Hold a proxied request open while another request refreshes revoked grants.
   Completing its cache save must retain the newer authorization snapshot.
   Logout/expiry must still reject late saves.
7. Confirm a layout grant leaves workload UI/resource permissions unchanged.
   Deny its associated workload and confirm the layout is hidden; an unassociated
   layout remains independently authorized. Existing Phase 1, workload and
   dashboard rendering, callbacks, controls and media still need local checks.

Record local checks separately; passing isolated tests does not establish live
database locking or AMPP integration behavior.

At implementation time, both builds, 134 API unit tests, 21 isolated HTTP tests
and lint on the new TypeScript files pass. A full `tsc --noEmit --incremental
false` also checks legacy test fixtures and reports four existing errors in
`src/auth/__tests__/mysql-session.store.spec.ts` and
`src/users/__tests__/client-permissions.service.spec.ts`; the unchanged `main`
baseline reports the same errors. The production build excludes those fixtures.
